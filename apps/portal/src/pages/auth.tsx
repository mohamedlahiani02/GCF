import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { api } from "../api/client";
import type { MemberProfile, SignupResult } from "../api/types";
import { usePortal } from "../auth/session";
import { ErrorBanner, Field, Notice, Spinner } from "../components/ui";
import { useI18n } from "../i18n/i18n";

/** Same minimum as the API (apps/api/src/auth/passwords.ts PASSWORD_MIN_LENGTH). */
const PASSWORD_MIN_LENGTH = 10;

function AuthCard({ title, intro, children }: { title: string; intro?: string; children: ReactNode }) {
  return (
    <div className="auth">
      <section className="card">
        <div className="card-b stack" style={{ gap: 16, padding: 24 }}>
          <div className="stack" style={{ gap: 4 }}>
            <h1 className="h1">{title}</h1>
            {intro ? <p className="cap">{intro}</p> : null}
          </div>
          {children}
        </div>
      </section>
    </div>
  );
}

function Submit({ pending, label }: { pending: boolean; label: string }) {
  return (
    <button type="submit" className="btn btn-p btn-l" disabled={pending}>
      {pending ? <Spinner /> : label}
    </button>
  );
}

const submit = (run: () => void) => (event: FormEvent) => {
  event.preventDefault();
  run();
};

export function LoginPage() {
  const { t } = useI18n();
  const { info, signedIn } = usePortal();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? "/";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const login = useMutation({
    mutationFn: () => api.post<MemberProfile>("/auth/login", { email, password }),
    onSuccess: (profile) => {
      signedIn(profile);
      navigate(from, { replace: true });
    },
  });
  return (
    <AuthCard title={t.auth.signInTitle} intro={t.auth.signInIntro}>
      <form className="stack" style={{ gap: 14 }} onSubmit={submit(() => login.mutate())}>
        <ErrorBanner error={login.error} />
        <Field label={t.auth.email}>
          <input className="input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label={t.auth.password}>
          <input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Submit pending={login.isPending} label={t.auth.signIn} />
      </form>
      <div className="stack" style={{ gap: 6, textAlign: "center" }}>
        <Link to="/mot-de-passe-oublie">{t.auth.forgotLink}</Link>
        {info?.selfSignup !== "closed" ? (
          <span className="cap">
            {t.auth.noAccount} <Link to="/inscription">{t.auth.createAccount}</Link>
          </span>
        ) : null}
      </div>
    </AuthCard>
  );
}

export function SignupPage() {
  const { t } = useI18n();
  const { info, signedIn } = usePortal();
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: "", password: "", firstName: "", lastName: "", phone: "", companyName: "" });
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const signup = useMutation({
    mutationFn: () => {
      const { companyName, ...rest } = form;
      return api.post<SignupResult>("/auth/signup", companyName.trim() ? { ...rest, companyName } : rest);
    },
    onSuccess: (result) => {
      if (result.status === "active") {
        signedIn(result);
        navigate("/", { replace: true });
      }
    },
  });
  if (info?.selfSignup === "closed") {
    return (
      <AuthCard title={t.auth.signupTitle}>
        <Notice tone="blue">{t.auth.signupClosed}</Notice>
        <Link to="/connexion">{t.auth.toSignIn}</Link>
      </AuthCard>
    );
  }
  if (signup.data?.status === "pending") {
    return (
      <AuthCard title={t.auth.signupTitle}>
        <Notice tone="green">{t.auth.signupPending}</Notice>
        <Link to="/connexion">{t.auth.toSignIn}</Link>
      </AuthCard>
    );
  }
  return (
    <AuthCard title={t.auth.signupTitle} intro={t.auth.signupIntro}>
      <form className="stack" style={{ gap: 14 }} onSubmit={submit(() => signup.mutate())}>
        <ErrorBanner error={signup.error} />
        <div className="grid2 portal-grid">
          <Field label={t.auth.firstName}>
            <input className="input" autoComplete="given-name" required maxLength={100} value={form.firstName} onChange={set("firstName")} />
          </Field>
          <Field label={t.auth.lastName}>
            <input className="input" autoComplete="family-name" required maxLength={100} value={form.lastName} onChange={set("lastName")} />
          </Field>
        </div>
        <Field label={t.auth.email}>
          <input className="input" type="email" autoComplete="email" required maxLength={254} value={form.email} onChange={set("email")} />
        </Field>
        <Field label={t.auth.phone}>
          <input className="input" type="tel" autoComplete="tel" required maxLength={40} value={form.phone} onChange={set("phone")} />
        </Field>
        <Field label={`${t.auth.companyName} (${t.common.optional})`}>
          <input className="input" autoComplete="organization" maxLength={150} value={form.companyName} onChange={set("companyName")} />
        </Field>
        <Field label={t.auth.password} hint={t.auth.passwordHint(PASSWORD_MIN_LENGTH)}>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            required
            minLength={PASSWORD_MIN_LENGTH}
            value={form.password}
            onChange={set("password")}
          />
        </Field>
        <Submit pending={signup.isPending} label={t.auth.signup} />
      </form>
      <span className="cap" style={{ textAlign: "center" }}>
        {t.auth.haveAccount} <Link to="/connexion">{t.auth.signIn}</Link>
      </span>
    </AuthCard>
  );
}

export function ForgotPage() {
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const forgot = useMutation({ mutationFn: () => api.post<void>("/auth/forgot", { email }) });
  return (
    <AuthCard title={t.auth.forgotTitle} intro={t.auth.forgotIntro}>
      {forgot.isSuccess ? (
        <Notice tone="green">{t.auth.forgotSent}</Notice>
      ) : (
        <form className="stack" style={{ gap: 14 }} onSubmit={submit(() => forgot.mutate())}>
          <ErrorBanner error={forgot.error} />
          <Field label={t.auth.email}>
            <input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Submit pending={forgot.isPending} label={t.auth.forgotSend} />
        </form>
      )}
      <Link to="/connexion" style={{ textAlign: "center" }}>
        {t.auth.toSignIn}
      </Link>
    </AuthCard>
  );
}

/**
 * Activation (staff invitation) and password reset: both set the password from the token of an e-mailed link and
 * open a session.
 */
export function TokenPasswordPage({ purpose }: { purpose: "activate" | "reset" }) {
  const { t } = useI18n();
  const { signedIn } = usePortal();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [mismatch, setMismatch] = useState(false);
  const save = useMutation({
    mutationFn: () => api.post<MemberProfile>(`/auth/${purpose}`, { token, password }),
    onSuccess: (profile) => {
      signedIn(profile);
      navigate("/", { replace: true });
    },
  });
  const title = purpose === "activate" ? t.auth.activationTitle : t.auth.resetTitle;
  const intro = purpose === "activate" ? t.auth.activationIntro : t.auth.resetIntro;
  if (!token) {
    return (
      <AuthCard title={title}>
        <div className="ban ban-red" role="alert">
          <span>{t.auth.missingToken}</span>
        </div>
        <Link to="/mot-de-passe-oublie">{t.auth.forgotLink}</Link>
      </AuthCard>
    );
  }
  return (
    <AuthCard title={title} intro={intro}>
      <form
        className="stack"
        style={{ gap: 14 }}
        onSubmit={submit(() => {
          setMismatch(password !== confirm);
          if (password === confirm) save.mutate();
        })}
      >
        <ErrorBanner error={save.error} />
        {mismatch ? (
          <div className="ban ban-red" role="alert">
            <span>{t.auth.passwordsDiffer}</span>
          </div>
        ) : null}
        <Field label={t.auth.password} hint={t.auth.passwordHint(PASSWORD_MIN_LENGTH)}>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            required
            minLength={PASSWORD_MIN_LENGTH}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field label={t.auth.confirmPassword}>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            required
            minLength={PASSWORD_MIN_LENGTH}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>
        <Submit pending={save.isPending} label={t.auth.setPassword} />
      </form>
      {save.error ? <Link to="/mot-de-passe-oublie">{t.auth.forgotLink}</Link> : null}
    </AuthCard>
  );
}
