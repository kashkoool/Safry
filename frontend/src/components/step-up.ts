import { ApiError } from "../lib/api";
import type { StepUp } from "../lib/platform";

export type Creds = { currentPassword: string; mfaCode: string };

/** Sends the step-up pair only when the dialog asked for it; an empty code is omitted. */
export function stepUpOf(form: Creds): StepUp {
  return { currentPassword: form.currentPassword, ...(form.mfaCode.trim() ? { mfaCode: form.mfaCode.trim() } : {}) };
}

/** A 401 on a step-up call means a wrong secret: returns the given text for it, null for anything else. */
export function stepUpError(reason: unknown, required: boolean, wrong: string): string | null {
  return required && reason instanceof ApiError && reason.status === 401 ? wrong : null;
}
