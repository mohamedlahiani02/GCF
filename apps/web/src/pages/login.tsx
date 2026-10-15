import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { api } from "../api/client";
import { useSession } from "../auth/session";
import { errorMessage } from "../lib/errors";

export function LoginPage() {
  const { session } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const client = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? "/";
  const login = useMutation({
    mutationFn: () => api.post("/auth/login", { email, password }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["session"] });
      navigate(from, { replace: true });
    },
  });
  if (session) return <Navigate to={from} replace />;
  return (
    <main className="login">
      <form
        className="card"
        style={{ width: 400 }}
        onSubmit={(e) => {
          e.preventDefault();
          login.mutate();
        }}
      >
        <div className="card-b stack" style={{ gap: 16, padding: 28 }}>
          <div className="brand">
            <span className="logo" aria-hidden="true">
              GC
            </span>
            <div>
              <div className="h2">Gestion du centre</div>
              <div className="cap">Back-office</div>
            </div>
          </div>
          {login.isError ? (
            <div className="ban ban-red" role="alert">
              <span>{errorMessage(login.error)}</span>
            </div>
          ) : null}
          <label className="field">
            <span className="lab">E-mail</span>
            <input
              className={`input${login.isError ? " err" : ""}`}
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="lab">Mot de passe</span>
            <input
              className={`input${login.isError ? " err" : ""}`}
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <button type="submit" className="btn btn-p btn-l" disabled={login.isPending}>
            {login.isPending ? <span className="spinner" aria-label="Connexion" /> : "Se connecter"}
          </button>
          <p className="cap" style={{ textAlign: "center" }}>
            Mot de passe oublié : demandez à l'administrateur du centre de le réinitialiser.
          </p>
        </div>
      </form>
    </main>
  );
}
