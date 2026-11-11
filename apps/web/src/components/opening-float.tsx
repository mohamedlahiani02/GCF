import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/client";
import { frDate, tnd, tryParseTnd } from "../lib/format";
import { useToast } from "./toasts";
import { ErrorBanner, Field, Modal } from "./ui";

interface Props {
  /** Where the float is saved: the centre's till or the café's. */
  endpoint: "/cash/opening" | "/cafe/opening";
  till: string;
  day: string;
  amount: number;
  recorded: boolean;
  suggested: number;
  expectedCash: number;
  /** False once the day is closed or when the role may not enter the float. */
  editable: boolean;
  queryKey: string;
}

/** The morning float of a till: what was put in, what the closing will expect, and the way to enter or correct it. */
export function OpeningFloat({ endpoint, till, day, amount, recorded, suggested, expectedCash, editable, queryKey }: Props) {
  const client = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const value = tryParseTnd(text);
  const save = useMutation({
    mutationFn: () => api.put(endpoint, { day, amount: value }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: [queryKey] });
      toast("Fond de caisse enregistré.");
      setOpen(false);
    },
  });
  return (
    <>
      <div className={recorded || !editable ? "ban ban-blue" : "ban ban-amber"} role="status">
        <span>
          <strong>Fond de caisse : {tnd(amount)} TND</strong>
          {recorded ? "" : editable ? " (non saisi ce jour)" : " (aucune saisie ce jour)"} · espèces attendues à la clôture : {tnd(expectedCash)} TND
        </span>
        {editable ? (
          <button
            type="button"
            className="btn"
            onClick={() => {
              setText(tnd(recorded ? amount : suggested));
              setOpen(true);
            }}
          >
            {recorded ? "Corriger" : "Saisir le fond de caisse"}
          </button>
        ) : null}
      </div>
      {open ? (
        <Modal
          title={`Fond de caisse, ${till}, ${frDate(day)}`}
          onClose={() => setOpen(false)}
          footer={
            <>
              <span className="cap">Modifiable jusqu'à la clôture de la journée</span>
              <div className="row" style={{ gap: 8 }}>
                <button type="button" className="btn" onClick={() => setOpen(false)}>
                  Annuler
                </button>
                <button type="button" className="btn btn-p" disabled={value === null || save.isPending} onClick={() => save.mutate()}>
                  Enregistrer
                </button>
              </div>
            </>
          }
        >
          <Field
            label="Espèces mises dans la caisse le matin (TND)"
            hint="La clôture attendra ce montant plus les espèces encaissées dans la journée."
            error={text && value === null ? "Montant invalide" : null}
          >
            <input className="input num" inputMode="decimal" autoFocus value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
          <ErrorBanner error={save.error} />
        </Modal>
      ) : null}
    </>
  );
}
