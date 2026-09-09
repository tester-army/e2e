"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";

const CANVAS_WIDTH = 480;
const CANVAS_HEIGHT = 360;
const SHAPE_SEQUENCE = ["square", "circle", "diamond"] as const;
const SHAPE_RECTS = {
  square: { x: 50, y: 170, width: 80, height: 80 },
  circle: { x: 200, y: 170, width: 80, height: 80 },
  diamond: { x: 350, y: 170, width: 80, height: 80 },
} as const;

type ShapeName = (typeof SHAPE_SEQUENCE)[number];
type Status = "idle" | "wrong" | "done";

/**
 * ADVERSARIAL: simulates canvas-rendered apps (Flutter web, game engines)
 * where everything is painted onto a single canvas element. There are no
 * test ids, no accessible roles, and the canvas is aria-hidden - DOM and
 * accessibility tooling see nothing. The agent must use pure vision to read
 * the painted instructions and click the shapes at their pixel coordinates
 * in the required order: square, then circle, then diamond.
 */
export default function CanvasOnly() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<Status>("idle");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }
    redraw(context, progress, status);
  }, [progress, status]);

  /**
   * Maps the click position from CSS pixels to canvas pixels, hit-tests the
   * fixed shape rects, and advances or resets the sequence accordingly.
   */
  const handleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (status === "done") {
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const scaleX = CANVAS_WIDTH / rect.width;
    const scaleY = CANVAS_HEIGHT / rect.height;
    const x = (event.clientX - rect.left) * scaleX;
    const y = (event.clientY - rect.top) * scaleY;

    const clicked = (Object.keys(SHAPE_RECTS) as ShapeName[]).find((name) => {
      const shape = SHAPE_RECTS[name];
      return (
        x >= shape.x && x <= shape.x + shape.width && y >= shape.y && y <= shape.y + shape.height
      );
    });
    if (!clicked) {
      return;
    }
    if (clicked !== SHAPE_SEQUENCE[progress]) {
      setProgress(0);
      setStatus("wrong");
      return;
    }
    const next = progress + 1;
    if (next === SHAPE_SEQUENCE.length) {
      setProgress(next);
      setStatus("done");
      return;
    }
    setProgress(next);
    setStatus("idle");
  };

  return (
    <div style={styles.container}>
      <canvas
        ref={canvasRef}
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        aria-hidden="true"
        role="presentation"
        style={styles.canvas}
        onClick={handleClick}
      />
    </div>
  );
}

/**
 * Repaints the whole scene from state: instructions, the three target
 * shapes, progress dots, and the wrong/complete status messages.
 */
function redraw(context: CanvasRenderingContext2D, progress: number, status: Status) {
  context.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  context.fillStyle = "#fff";
  context.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  context.fillStyle = "#111";
  context.font = "600 18px sans-serif";
  context.textAlign = "center";
  context.fillText("Click: square, then circle, then diamond", CANVAS_WIDTH / 2, 50);

  context.fillStyle = "#444";
  const square = SHAPE_RECTS.square;
  context.fillRect(square.x, square.y, square.width, square.height);

  const circle = SHAPE_RECTS.circle;
  context.beginPath();
  context.arc(
    circle.x + circle.width / 2,
    circle.y + circle.height / 2,
    circle.width / 2,
    0,
    Math.PI * 2,
  );
  context.fill();

  const diamond = SHAPE_RECTS.diamond;
  context.beginPath();
  context.moveTo(diamond.x + diamond.width / 2, diamond.y);
  context.lineTo(diamond.x + diamond.width, diamond.y + diamond.height / 2);
  context.lineTo(diamond.x + diamond.width / 2, diamond.y + diamond.height);
  context.lineTo(diamond.x, diamond.y + diamond.height / 2);
  context.closePath();
  context.fill();

  for (let index = 0; index < SHAPE_SEQUENCE.length; index += 1) {
    context.beginPath();
    context.arc(CANVAS_WIDTH / 2 - 30 + index * 30, 100, 8, 0, Math.PI * 2);
    context.fillStyle = index < progress ? "#0a0" : "#ccc";
    context.fill();
  }

  if (status === "wrong") {
    context.fillStyle = "#c00";
    context.font = "600 16px sans-serif";
    context.fillText("Wrong shape, try again", CANVAS_WIDTH / 2, 320);
  }
  if (status === "done") {
    context.fillStyle = "#0a0";
    context.font = "600 20px sans-serif";
    context.fillText("Sequence complete", CANVAS_WIDTH / 2, 320);
  }
}

const styles = {
  container: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
    padding: "24px 0",
  },
  canvas: {
    width: 480,
    maxWidth: "100%",
    border: "1px solid #ccc",
    borderRadius: 8,
  },
} satisfies Record<string, CSSProperties>;
