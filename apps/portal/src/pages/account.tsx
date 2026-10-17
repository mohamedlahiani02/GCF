import { CW_CATEGORY_LABELS } from "@gcf/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/client";
import type { MemberProfile, Team, TeamBooking } from "../api/types";
import { useMember, usePortal } from "../auth/session";
import { BookingStatusBadge } from "../components/badges";
import { Badge, Card, Empty, ErrorBanner, Field, Loading, Notice, PageHeader, Spinner } from "../components/ui";
import { useI18n } from "../i18n/i18n";
import { PASSWORD_MIN_LENGTH } from "./auth";
import { useFormat } from "../lib/format";

function ProfileForm() {
  const member = useMember();
  const { signedIn } = usePortal();
  const { t } = useI18n();
  const [form, setForm] = useState({ firstName: member.firstName, lastName: member.lastName ?? "", phone: member.phone ?? "" });
  const save = useMutation({
    mutationFn: () => api.patch<MemberProfile>("/me", form),
    onSuccess: signedIn,
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Card
        title={t.account.profile}
        footer={
          <>
            <span />
            <button type="submit" className="btn btn-p" disabled={save.isPending}>
              {save.isPending ? <Spinner /> : t.common.save}
            </button>
          </>
        }
      >
        <div className="card-b stack">
          {save.isSuccess ? <Notice tone="green">{t.common.saved}</Notice> : null}
          <ErrorBanner error={save.error} />
          <div className="grid2 portal-grid">
            <Field label={t.auth.firstName}>
              <input
                className="input"
                autoComplete="given-name"
                required
                maxLength={100}
                value={form.firstName}
                onChange={(e) => setForm({ ...form, firstName: e.target.value })}
              />
            </Field>
            <Field label={t.auth.lastName}>
              <input
                className="input"
                autoComplete="family-name"
                required
                maxLength={100}
                value={form.lastName}
                onChange={(e) => setForm({ ...form, lastName: e.target.value })}
              />
            </Field>
            <Field label={t.auth.phone}>
              <input
                className="input"
                type="tel"
                autoComplete="tel"
                required
                maxLength={40}
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
              />
            </Field>
            <Field label={t.auth.email} hint={t.account.emailHint}>
              <input className="input" type="email" value={member.email ?? ""} readOnly />
            </Field>
          </div>
          {member.company ? (
            <span>
              {t.common.pair(t.account.company, member.company.name)}{" "}
              <Badge tone="neutral">{member.company.role === "admin" ? t.account.companyAdmin : t.account.companyMember}</Badge>
            </span>
          ) : null}
        </div>
      </Card>
    </form>
  );
}

function PasswordForm() {
  const { t } = useI18n();
  const [currentPassword, setCurrent] = useState("");
  const [newPassword, setNext] = useState("");
  const change = useMutation({
    mutationFn: () => api.post<void>("/me/password", { currentPassword, newPassword }),
    onSuccess: () => {
      setCurrent("");
      setNext("");
    },
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        change.mutate();
      }}
    >
      <Card
        title={t.account.password}
        footer={
          <>
            <span />
            <button type="submit" className="btn btn-p" disabled={change.isPending}>
              {change.isPending ? <Spinner /> : t.account.changePassword}
            </button>
          </>
        }
      >
        <div className="card-b stack">
          {change.isSuccess ? <Notice tone="green">{t.account.passwordChanged}</Notice> : null}
          <ErrorBanner error={change.error} />
          <div className="grid2 portal-grid">
            <Field label={t.account.currentPassword}>
              <input
                className="input"
                type="password"
                autoComplete="current-password"
                required
                value={currentPassword}
                onChange={(e) => setCurrent(e.target.value)}
              />
            </Field>
            <Field label={t.account.newPassword} hint={t.auth.passwordHint(PASSWORD_MIN_LENGTH)}>
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                required
                minLength={PASSWORD_MIN_LENGTH}
                value={newPassword}
                onChange={(e) => setNext(e.target.value)}
              />
            </Field>
          </div>
        </div>
      </Card>
    </form>
  );
}

export function AccountPage() {
  const { t } = useI18n();
  return (
    <>
      <PageHeader title={t.account.title} />
      <ProfileForm />
      <PasswordForm />
    </>
  );
}

export function TeamPage() {
  const { t, language } = useI18n();
  const f = useFormat();
  const team = useQuery({ queryKey: ["team"], queryFn: () => api.get<Team>("/team") });
  const bookings = useQuery({ queryKey: ["team-bookings"], queryFn: () => api.get<{ items: TeamBooking[] }>("/team/bookings") });
  return (
    <>
      <PageHeader title={team.data ? t.common.pair(t.team.title, team.data.company.name) : t.team.title} />
      <ErrorBanner error={team.error ?? bookings.error} />
      <Card title={t.team.members}>
        {team.isPending ? (
          <Loading />
        ) : team.data ? (
          <div className="xs">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t.team.name}</th>
                  <th>{t.team.role}</th>
                  <th>{t.team.status}</th>
                  <th className="num">{t.team.upcoming}</th>
                </tr>
              </thead>
              <tbody>
                {team.data.members.map((m) => (
                  <tr key={m.id}>
                    <td>
                      {m.firstName} {m.lastName}
                      {m.isMe ? <span className="cap"> ({t.team.me})</span> : null}
                    </td>
                    <td>{m.companyRole === "admin" ? t.team.admin : t.team.member}</td>
                    <td>
                      <Badge tone={m.status === "active" ? "green" : "amber"}>{m.status === "active" ? t.team.active : t.team.pending}</Badge>
                    </td>
                    <td className="num">{m.upcomingBookings}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
      <Card title={t.team.bookings}>
        {bookings.isPending ? (
          <Loading />
        ) : bookings.data?.items.length ? (
          <div className="xs">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t.team.who}</th>
                  <th>{t.bookings.date}</th>
                  <th>{t.bookings.time}</th>
                  <th>{t.bookings.space}</th>
                  <th>{t.bookings.status}</th>
                </tr>
              </thead>
              <tbody>
                {bookings.data.items.map((b) => (
                  <tr key={b.id}>
                    <td>{b.memberName}</td>
                    <td>{f.date(b.date, true)}</td>
                    <td>
                      {b.startTime} - {b.endTime}
                    </td>
                    <td>
                      {CW_CATEGORY_LABELS[language][b.category]} {b.resourceCode}
                      <div className="cap">{b.typeName}</div>
                    </td>
                    <td>
                      <BookingStatusBadge status={b.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title={t.team.noBookings} />
        )}
      </Card>
    </>
  );
}
