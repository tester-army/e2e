/** Private closed SDK missing-checkpoint byte protocol. No collector/exporter runtime imports. */
export interface CheckpointUnavailableFacts {
  readonly attemptId: string;
  readonly stepId: string | undefined;
  readonly attemptedAt: string | undefined;
  readonly association: {
    readonly checkpointId: string;
    readonly phase: "before" | "after";
    readonly observationId: string | null;
    readonly observationRevision: string | null;
  } | undefined;
}

/** Admits only canonical SDK JSON bytes joined to original sink/ticket boundary facts. */
export function checkpointUnavailableBytesProven(bytes: Uint8Array, facts: CheckpointUnavailableFacts | undefined): boolean {
  if (facts === undefined) return false;
  try {
    // Fatal decoding plus a byte round-trip rejects BOMs and alternate encodings too.
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    const canonical = JSON.stringify(value);
    if (text !== canonical && text !== canonical + "\n") return false;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    const keys = ["format", "id", "attemptId", "stepId", "stepIndex", "phase", "attemptedAt", "semantics", "image"];
    if (Object.keys(record).length !== keys.length || Object.keys(record).some((key) => !keys.includes(key))) return false;
    const missing = (part: unknown, image: boolean): boolean => {
      if (part === null || typeof part !== "object" || Array.isArray(part)) return false;
      const field = part as Record<string, unknown>;
      return Object.keys(field).length === 2 && Object.hasOwn(field, "status") && Object.hasOwn(field, "reason") &&
        field.status === "unavailable" && typeof field.reason === "string" &&
        ["UNSUPPORTED_CAPABILITY", "CAPTURE_UNAVAILABLE", "CAPTURE_TIMEOUT", "CANCELLED", "EVIDENCE_LIMIT", ...(image ? ["ARTIFACT_UNAVAILABLE"] : [])].includes(field.reason);
    };
    const association = facts.association;
    if (association === undefined || facts.stepId === undefined || facts.attemptedAt === undefined) return false;
    const time = record.attemptedAt;
    return record.format === "debug-checkpoint-1" && record.attemptId === facts.attemptId && record.stepId === facts.stepId &&
      typeof record.stepIndex === "number" && Number.isSafeInteger(record.stepIndex) && record.stepIndex >= 0 &&
      record.stepId === `${facts.attemptId}:${record.stepIndex}` && record.id === association.checkpointId &&
      record.id === `${facts.stepId}:checkpoint:${association.phase}` && record.phase === association.phase &&
      ["before", "after"].includes(association.phase) &&
      association.observationId === null && association.observationRevision === null &&
      typeof time === "string" && time.length === 24 && time === facts.attemptedAt && Number.isFinite(Date.parse(time)) &&
      new Date(time).toISOString() === time && missing(record.semantics, false) && missing(record.image, true);
  } catch { return false; }
}
