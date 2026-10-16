"use client";

import { useActionState, useEffect, useRef } from "react";
import { requestMagicLink, type LoginState } from "./actions";

type TurnstileApi = {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": () => void;
    },
  ) => string;
  reset: (widgetId?: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const initialState: LoginState = { status: "idle" };

export function LoginForm({ siteKey }: { siteKey: string }) {
  const [state, formAction, pending] = useActionState(requestMagicLink, initialState);
  const widgetRef = useRef<HTMLDivElement>(null);
  const tokenRef = useRef<HTMLInputElement>(null);
  const widgetIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const container = widgetRef.current;
    if (!container || !siteKey) return;
    let cancelled = false;

    const setToken = (value: string) => {
      if (tokenRef.current) tokenRef.current.value = value;
    };

    const renderWidget = () => {
      if (cancelled || !window.turnstile || widgetIdRef.current !== undefined) return;
      widgetIdRef.current = window.turnstile.render(container, {
        sitekey: siteKey,
        callback: setToken,
        "expired-callback": () => setToken(""),
        "error-callback": () => setToken(""),
      });
    };

    if (window.turnstile) {
      renderWidget();
    } else {
      let script = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_SRC}"]`);
      if (!script) {
        script = document.createElement("script");
        script.src = SCRIPT_SRC;
        script.async = true;
        document.head.appendChild(script);
      }
      script.addEventListener("load", renderWidget);
    }

    return () => {
      cancelled = true;
    };
  }, [siteKey]);

  // Turnstile tokens are single-use: get a fresh one after every attempt.
  useEffect(() => {
    if (state.status === "idle") return;
    if (tokenRef.current) tokenRef.current.value = "";
    if (widgetIdRef.current !== undefined) window.turnstile?.reset(widgetIdRef.current);
  }, [state]);

  return (
    <form action={formAction}>
      <label className="pm-field">
        Email
        <input
          type="email"
          name="email"
          required
          autoComplete="email"
          placeholder="you@example.com"
          className="pm-input"
        />
      </label>

      <input type="hidden" name="captchaToken" ref={tokenRef} defaultValue="" />
      <div ref={widgetRef} className="pm-turnstile" />

      <button
        type="submit"
        disabled={pending}
        className="pm-btn pm-btn-primary pm-btn-block"
      >
        {pending ? "Sending…" : "Email me a sign-in link"}
      </button>

      {state.message ? (
        <p role="status" className={state.status === "error" ? "pm-note pm-note-bad" : "pm-note pm-note-ok"}>
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
