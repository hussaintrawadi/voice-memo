import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type InputHTMLAttributes, type ReactNode, useState } from "react";
import { Button, Card, ErrorNote } from "../components/ui";
import type { AuthState } from "../lib/api";
import { login, resetPassword, setupAccount } from "../lib/session";

type Mode = "login" | "setup" | "reset";

function Field({
  label,
  hint,
  className = "",
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      <input
        {...props}
        className={`mt-1 h-11 w-full rounded-xl border border-line bg-bg px-3 text-[15px] outline-none focus:border-brand ${className}`}
      />
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function Welcome({ auth }: { auth: AuthState }) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>(auth.initialized ? "login" : "setup");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [setupCode, setSetupCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (mode !== "login" && password !== confirm) {
      setError(new Error("The two passwords don't match"));
      return;
    }
    setBusy(true);
    try {
      if (mode === "login") await login({ email, password });
      else if (mode === "setup") await setupAccount({ name, email, password, setupCode });
      else await resetPassword({ email, setupCode, newPassword: password });
      await queryClient.invalidateQueries({ queryKey: ["auth"] });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const switchTo = (next: Mode) => {
    setMode(next);
    setError(null);
    setPassword("");
    setConfirm("");
  };

  const titles: Record<Mode, { heading: string; body: string; action: string }> = {
    login: { heading: "Welcome back", body: "Sign in to your memory.", action: "Sign in" },
    setup: {
      heading: "Create your account",
      body: "This app has a single account: yours. You'll need the setup code once.",
      action: "Create account",
    },
    reset: {
      heading: "Reset password",
      body: "Your setup code is your recovery key. Resetting signs out your other devices.",
      action: "Set new password",
    },
  };
  const t = titles[mode];

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-5 py-10">
      <img src="/icon.svg" alt="" className="mb-6 size-16 rounded-2xl" />
      <h1 className="font-serif text-4xl leading-tight">Voice Memo</h1>
      <p className="mt-2 text-muted">Speak a thought. It gets transcribed, organised and connected to everything you've said before.</p>

      <Card className="mt-8 p-5">
        <h2 className="text-lg font-semibold">{t.heading}</h2>
        <p className="mt-1 text-sm text-muted">{t.body}</p>
        <form onSubmit={submit} className="mt-5 space-y-4">
          {mode === "setup" && (
            <Field
              label="Your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              required
            />
          )}
          <Field
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            inputMode="email"
            autoCapitalize="off"
            required
          />
          <Field
            label={mode === "login" ? "Password" : "New password"}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            minLength={mode === "login" ? undefined : 10}
            hint={mode === "login" ? undefined : "At least 10 characters."}
            required
          />
          {mode !== "login" && (
            <Field
              label="Confirm password"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              required
            />
          )}
          {mode !== "login" && (
            <Field
              label="Setup code"
              value={setupCode}
              onChange={(e) => setSetupCode(e.target.value)}
              autoComplete="one-time-code"
              autoCapitalize="off"
              spellCheck={false}
              className="font-mono"
              required
            />
          )}
          <Button type="submit" variant="primary" className="w-full" busy={busy}>
            {t.action}
          </Button>
        </form>
        <ErrorNote error={error} />

        <div className="mt-5 text-center text-sm">
          {mode === "login" && (
            <button type="button" onClick={() => switchTo("reset")} className="text-muted underline-offset-2 hover:underline">
              Forgot password?
            </button>
          )}
          {mode === "reset" && (
            <button type="button" onClick={() => switchTo("login")} className="text-muted underline-offset-2 hover:underline">
              Back to sign in
            </button>
          )}
        </div>
      </Card>
    </main>
  );
}
