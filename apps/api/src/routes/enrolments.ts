import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { can } from "../auth/permissions.js";
import { buildSchedule, discountAmount, loadGroupBilling, resolveTerms, type EnrolmentTerms, type ScheduleLine } from "../domain/enrolmentSchedule.js";
import { dropEnrolment, transferEnrolment } from "../domain/enrolmentChanges.js";
import { recordFinancialEvents } from "../domain/financialEvents.js";
import { lockStudent, settleStudent } from "../domain/ledger.js";
import { conflict, notFound, unprocessable } from "../errors.js";
import { basisPoints, idParam, isoDate, millimes, reason, uuid } from "../validation.js";

const discount = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("percent"), value: basisPoints, reason }).strict(),
  z.object({ kind: z.literal("amount"), value: millimes.min(1), reason }).strict(),
]);

const enrolmentBody = z
  .object({
    studentId: uuid,
    groupId: uuid,
    effectiveDate: isoDate,
    paymentMode: z.enum(["full", "installments", "monthly", "per_session"]).optional(),
    planId: uuid.optional(),
    firstDueDate: isoDate.optional(),
    discount: discount.optional(),
  })
  .strict();

const transferBody = z.object({ newGroupId: uuid, effectiveDate: isoDate, mode: z.enum(["keep", "reprice"]), reason }).strict();
const dropBody = z.object({ date: isoDate, reason }).strict();
const decisionBody = z.object({ approve: z.boolean(), reason: reason.optional() }).strict();
const listQuery = z.object({ studentId: uuid.optional(), groupId: uuid.optional() });

interface Preview {
  terms: EnrolmentTerms;
  lines: ScheduleLine[];
  discount: { amount: number; reason: string } | null;
  total: number;
}

export const enrolmentRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  const write = app.requirePermission("enrolments:write");

  const preview = async (body: z.infer<typeof enrolmentBody>, centreId: string): Promise<Preview & { group: Awaited<ReturnType<typeof loadGroupBilling>> }> => {
    const group = await loadGroupBilling(db, body.groupId, centreId);
    if (group.status !== "active") throw unprocessable("group_archived", "the group is archived");
    if (body.effectiveDate > group.endDate) throw unprocessable("after_group_end", "the enrolment starts after the end of the group");
    const { terms } = await resolveTerms(db, group, body, centreId);
    const lines = await buildSchedule(db, group, body, centreId);
    const charges = lines.reduce((s, l) => s + l.amount, 0);
    const discountValue = body.discount ? { amount: discountAmount(lines, body.discount), reason: body.discount.reason } : null;
    return { group, terms, lines, discount: discountValue, total: charges - (discountValue?.amount ?? 0) };
  };

  app.post("/preview", { preHandler: write }, async (request) => {
    const body = enrolmentBody.parse(request.body);
    const { terms, lines, discount: d, total } = await preview(body, request.user!.centreId);
    return { paymentMode: terms.paymentMode, sessionPrice: terms.sessionPrice, lines, discount: d, total };
  });

  app.post("/", { preHandler: write }, async (request, reply) => {
    const actor = request.user!;
    const body = enrolmentBody.parse(request.body);
    const student = await db
      .selectFrom("students")
      .select(["id", "status"])
      .where("id", "=", body.studentId)
      .where("centre_id", "=", actor.centreId)
      .executeTakeFirst();
    if (!student) throw notFound("student");
    if (student.status !== "active") throw unprocessable("student_archived", "the student is archived");
    const { group, terms, lines, discount: d } = await preview(body, actor.centreId);
    const canApprove = can(actor.role, "discounts:approve");

    const enrolment = await db.transaction().execute(async (trx) => {
      await lockStudent(trx, body.studentId, actor.centreId);
      // Serialises enrolments into the same group so the capacity check cannot be raced.
      await trx.selectFrom("groups").select("id").where("id", "=", group.groupId).forUpdate().executeTakeFirstOrThrow();
      const enrolled = await trx
        .selectFrom("enrolments")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .where("group_id", "=", group.groupId)
        .where("status", "=", "active")
        .executeTakeFirstOrThrow();
      if (Number(enrolled.count) >= group.capacity) throw conflict("group_full", "the group has reached its capacity");

      const created = await trx
        .insertInto("enrolments")
        .values({
          centre_id: actor.centreId,
          student_id: body.studentId,
          group_id: body.groupId,
          effective_date: body.effectiveDate,
          payment_mode: terms.paymentMode,
          plan_id: terms.planId,
          session_price: terms.sessionPrice,
          session_absence_billed: terms.sessionAbsenceBilled,
          created_by: actor.userId,
        })
        .returning(["id", "effective_date as effectiveDate", "payment_mode as paymentMode", "status"])
        .executeTakeFirstOrThrow();

      const charges = lines.length
        ? await trx
            .insertInto("installments")
            .values(
              lines.map((l) => ({
                centre_id: actor.centreId,
                enrolment_id: created.id,
                label: l.label,
                kind: "charge" as const,
                amount: l.amount,
                due_date: l.dueDate,
                original_due_date: l.dueDate,
                discount_status: null,
                created_by: actor.userId,
              })),
            )
            .returning(["id", "amount"])
            .execute()
        : [];
      let discountRow: { id: string; amount: number } | undefined;
      if (d) {
        const firstDue = lines[0]!.dueDate;
        discountRow = await trx
          .insertInto("installments")
          .values({
            centre_id: actor.centreId,
            enrolment_id: created.id,
            label: `Remise : ${d.reason}`,
            kind: "discount",
            amount: -d.amount,
            due_date: firstDue,
            original_due_date: firstDue,
            discount_status: canApprove ? "approved" : "pending",
            created_by: actor.userId,
          })
          .returning(["id", "amount"])
          .executeTakeFirstOrThrow();
      }
      const axes = {
        studentId: body.studentId,
        enrolmentId: created.id,
        groupId: group.groupId,
        studyId: group.studyId,
        trainingId: group.trainingId,
        instructorId: group.instructorId,
      };
      await recordFinancialEvents(trx, [
        ...charges.map((c) => ({
          centreId: actor.centreId,
          type: "installment_issued" as const,
          amount: c.amount,
          userId: actor.userId,
          installmentId: c.id,
          ...axes,
        })),
        ...(discountRow && canApprove
          ? [
              {
                centreId: actor.centreId,
                type: "discount_granted" as const,
                amount: discountRow.amount,
                userId: actor.userId,
                installmentId: discountRow.id,
                ...axes,
              },
            ]
          : []),
      ]);
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "enrolment.created",
        objectType: "enrolment",
        objectId: created.id,
        after: { ...body, lines, discount: d },
      });
      // Credit the student already holds pays the new schedule straight away.
      await settleStudent(trx, actor.centreId, body.studentId, actor.userId);
      return created;
    });
    return reply.status(201).send({ ...enrolment, groupId: body.groupId, studentId: body.studentId });
  });

  app.get("/", { preHandler: app.requirePermission("students:read") }, async (request) => {
    const query = listQuery.parse(request.query);
    if (!query.studentId && !query.groupId) throw unprocessable("filter_required", "filter by studentId or groupId");
    return db
      .selectFrom("enrolments")
      .innerJoin("groups", "groups.id", "enrolments.group_id")
      .innerJoin("students", "students.id", "enrolments.student_id")
      .leftJoin("studies", "studies.id", "groups.study_id")
      .leftJoin("training_sessions", "training_sessions.id", "groups.training_session_id")
      .leftJoin("trainings", "trainings.id", "training_sessions.training_id")
      .select([
        "enrolments.id",
        "enrolments.student_id as studentId",
        "students.first_name as firstName",
        "students.last_name as lastName",
        "enrolments.group_id as groupId",
        "groups.name as groupName",
        "groups.kind",
        "studies.name as studyName",
        "trainings.title as trainingTitle",
        "enrolments.effective_date as effectiveDate",
        "enrolments.end_date as endDate",
        "enrolments.status",
        "enrolments.payment_mode as paymentMode",
        "enrolments.transferred_from_id as transferredFromId",
        "enrolments.ended_reason as endedReason",
      ])
      .where("enrolments.centre_id", "=", request.user!.centreId)
      .$if(query.studentId !== undefined, (qb) => qb.where("enrolments.student_id", "=", query.studentId!))
      .$if(query.groupId !== undefined, (qb) => qb.where("enrolments.group_id", "=", query.groupId!))
      .orderBy("enrolments.effective_date", "desc")
      .execute();
  });

  app.post("/:id/transfer", { preHandler: write }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = transferBody.parse(request.body);
    return db.transaction().execute(async (trx) => {
      const result = await transferEnrolment(trx, actor, id, body);
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "enrolment.transferred",
        objectType: "enrolment",
        objectId: id,
        after: { ...body, ...result },
        reason: body.reason,
      });
      return result;
    });
  });

  app.post("/:id/drop", { preHandler: write }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = dropBody.parse(request.body);
    return db.transaction().execute(async (trx) => {
      const result = await dropEnrolment(trx, actor, id, body);
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: "enrolment.dropped",
        objectType: "enrolment",
        objectId: id,
        after: { ...body, ...result },
        reason: body.reason,
      });
      return result;
    });
  });

  /** Approves or rejects a discount entered by someone who could not approve it. */
  app.post("/discounts/:id/decision", { preHandler: app.requirePermission("discounts:approve") }, async (request) => {
    const actor = request.user!;
    const { id } = idParam.parse(request.params);
    const body = decisionBody.parse(request.body);
    if (!body.approve && !body.reason) throw unprocessable("reason_required", "a rejection needs a reason");
    return db.transaction().execute(async (trx) => {
      const discountRow = await trx
        .selectFrom("installments")
        .innerJoin("enrolments", "enrolments.id", "installments.enrolment_id")
        .innerJoin("groups", "groups.id", "enrolments.group_id")
        .leftJoin("training_sessions", "training_sessions.id", "groups.training_session_id")
        .select([
          "installments.id",
          "installments.amount",
          "installments.kind",
          "installments.discount_status as discountStatus",
          "enrolments.id as enrolmentId",
          "enrolments.student_id as studentId",
          "groups.id as groupId",
          "groups.study_id as studyId",
          "training_sessions.training_id as trainingId",
          "groups.instructor_id as instructorId",
        ])
        .where("installments.id", "=", id)
        .where("installments.centre_id", "=", actor.centreId)
        .forUpdate("installments")
        .executeTakeFirst();
      if (!discountRow || discountRow.kind !== "discount") throw notFound("discount");
      if (discountRow.discountStatus !== "pending") throw conflict("already_decided", "this discount has already been decided");
      const status = body.approve ? "approved" : "rejected";
      await trx.updateTable("installments").set({ discount_status: status }).where("id", "=", id).execute();
      if (body.approve) {
        await lockStudent(trx, discountRow.studentId, actor.centreId);
        await recordFinancialEvents(trx, [
          {
            centreId: actor.centreId,
            type: "discount_granted",
            amount: discountRow.amount,
            userId: actor.userId,
            installmentId: id,
            studentId: discountRow.studentId,
            enrolmentId: discountRow.enrolmentId,
            groupId: discountRow.groupId,
            studyId: discountRow.studyId,
            trainingId: discountRow.trainingId,
            instructorId: discountRow.instructorId,
          },
        ]);
        await settleStudent(trx, actor.centreId, discountRow.studentId, actor.userId);
      }
      await writeAudit(trx, {
        centreId: actor.centreId,
        userId: actor.userId,
        action: `discount.${status}`,
        objectType: "installment",
        objectId: id,
        before: { discountStatus: "pending" },
        after: { discountStatus: status },
        reason: body.reason ?? null,
      });
      return { id, discountStatus: status };
    });
  });
};
