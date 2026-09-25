"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";

const COUPON_CODE = "SAVE-1234";

const COUPON_FRAME_SRCDOC = `<!DOCTYPE html>
<html>
  <body style="margin:0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;background:#f6f6f6;">
    <p style="font-size:18px;font-weight:600;color:#111;margin:0;">
      Your coupon code: <span style="font-family:monospace;">${COUPON_CODE}</span>
    </p>
  </body>
</html>`;

const CHECKOUT_FRAME_SRCDOC = `<!DOCTYPE html>
<html>
  <body style="margin:0;font-family:sans-serif;padding:16px;">
    <form style="display:flex;flex-direction:column;gap:12px;" onsubmit="return false;">
      <label style="font-size:13px;color:#666;">Apply your coupon at checkout</label>
      <input
        id="coupon"
        placeholder="Coupon code"
        style="border:1px solid #ccc;border-radius:8px;padding:10px 12px;font-size:16px;"
      />
      <button
        type="button"
        id="apply"
        style="background:#111;color:#fff;border:none;border-radius:8px;padding:12px 16px;font-size:16px;font-weight:600;cursor:pointer;"
      >
        Apply
      </button>
    </form>
    <script>
      document.getElementById("apply").addEventListener("click", function () {
        var value = document.getElementById("coupon").value;
        window.parent.postMessage({ type: "apply-coupon", code: value }, "*");
      });
    </script>
  </body>
</html>`;

export default function IframeForm() {
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);
  const checkoutFrameRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    /**
     * Receives the postMessage sent by the checkout iframe's Apply button
     * and validates the submitted coupon code in the parent document. Only
     * messages originating from the checkout iframe's own window are
     * accepted so no other frame or opener can drive this state.
     */
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== checkoutFrameRef.current?.contentWindow) {
        return;
      }
      const data: unknown = event.data;
      if (
        typeof data !== "object" ||
        data === null ||
        (data as { type?: unknown }).type !== "apply-coupon"
      ) {
        return;
      }
      const code = (data as { code?: unknown }).code;
      if (typeof code !== "string") {
        return;
      }
      if (code.trim() === COUPON_CODE) {
        setError(null);
        setApplied(true);
        return;
      }
      setError("Invalid coupon code");
    };

    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, []);

  if (applied) {
    return (
      <div style={styles.container}>
        <p data-testid="success-message" style={styles.successText}>
          Coupon applied
        </p>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <p style={styles.hint}>
        Read the coupon code from the first frame and apply it in the second.
      </p>
      <iframe title="coupon-frame" srcDoc={COUPON_FRAME_SRCDOC} style={styles.couponFrame} />
      <iframe
        ref={checkoutFrameRef}
        title="checkout-frame"
        srcDoc={CHECKOUT_FRAME_SRCDOC}
        style={styles.checkoutFrame}
      />
      {error ? (
        <p data-testid="error-message" style={styles.errorText}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

const styles = {
  container: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
    padding: "24px 0",
  },
  hint: {
    fontSize: 13,
    color: "#666",
    textAlign: "center",
    margin: 0,
  },
  couponFrame: {
    width: "100%",
    height: 140,
    border: "1px solid #ccc",
    borderRadius: 8,
  },
  checkoutFrame: {
    width: "100%",
    height: 220,
    border: "1px solid #ccc",
    borderRadius: 8,
  },
  errorText: {
    color: "#c00",
    fontSize: 14,
    margin: 0,
  },
  successText: {
    fontSize: 20,
    fontWeight: 600,
    color: "#0a0",
    textAlign: "center",
    margin: "0 0 16px",
  },
} satisfies Record<string, CSSProperties>;
