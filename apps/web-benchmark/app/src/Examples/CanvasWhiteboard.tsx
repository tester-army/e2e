"use client";

import { type CSSProperties, type PointerEvent, useEffect, useRef, useState } from "react";

const CANVAS_WIDTH = 640;
const CANVAS_HEIGHT = 440;

const TOOLBAR_HEIGHT = 56;
const SAVE_BUTTON = { x: 516, y: 12, width: 108, height: 32 };

const RECT_SIZE = { width: 90, height: 70 };
const RECT_HOME = { x: 60, y: 130 };
const RECT_SLOT = { x: 430, y: 130 };

const CIRCLE_RADIUS = 40;
const CIRCLE_HOME = { x: 105, y: 320 };
const CIRCLE_SLOT = { x: 475, y: 320 };

type Point = { x: number; y: number };
type ShapeName = "rect" | "circle";
type DragInfo = { shape: ShapeName; offsetX: number; offsetY: number };
type Message = "idle" | "wrong-slot" | "missed" | "incomplete";

/**
 * ADVERSARIAL: a Figma/Excalidraw style whiteboard where the whole app -
 * toolbar, shapes, drop slots, and status - is painted onto one aria-hidden
 * canvas. There is no DOM to query and clicks alone do nothing to the shapes.
 * The agent must visually locate the blue rectangle and the orange circle,
 * drag each onto its matching dashed slot with real pointer press-move-release
 * sequences at pixel coordinates, and then click the painted Save button.
 * Wrong or missed drops send the shape back to the shelf. Success exists only
 * in pixels: the painted "Design saved" banner.
 */
export default function CanvasWhiteboard() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<DragInfo | null>(null);
  const [rectPos, setRectPos] = useState<Point>(RECT_HOME);
  const [circleCenter, setCircleCenter] = useState<Point>(CIRCLE_HOME);
  const [rectPlaced, setRectPlaced] = useState(false);
  const [circlePlaced, setCirclePlaced] = useState(false);
  const [saved, setSaved] = useState(false);
  const [message, setMessage] = useState<Message>("idle");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }
    redraw(context, { rectPos, circleCenter, rectPlaced, circlePlaced, saved, message });
  }, [rectPos, circleCenter, rectPlaced, circlePlaced, saved, message]);

  /**
   * Maps a pointer event from CSS pixels to canvas pixels so hit-testing and
   * painting share one coordinate space.
   */
  const toCanvasPoint = (event: PointerEvent<HTMLCanvasElement>): Point | null => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return null;
    }
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) * CANVAS_WIDTH) / rect.width,
      y: ((event.clientY - rect.top) * CANVAS_HEIGHT) / rect.height,
    };
  };

  /**
   * Hit-tests the unplaced shapes and starts a drag, remembering the grab
   * offset so the shape does not jump under the pointer.
   */
  const handlePointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (saved) {
      return;
    }
    const point = toCanvasPoint(event);
    if (!point) {
      return;
    }
    if (
      !circlePlaced &&
      Math.hypot(point.x - circleCenter.x, point.y - circleCenter.y) <= CIRCLE_RADIUS
    ) {
      dragRef.current = {
        shape: "circle",
        offsetX: point.x - circleCenter.x,
        offsetY: point.y - circleCenter.y,
      };
    } else if (
      !rectPlaced &&
      point.x >= rectPos.x &&
      point.x <= rectPos.x + RECT_SIZE.width &&
      point.y >= rectPos.y &&
      point.y <= rectPos.y + RECT_SIZE.height
    ) {
      dragRef.current = {
        shape: "rect",
        offsetX: point.x - rectPos.x,
        offsetY: point.y - rectPos.y,
      };
    } else {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    setMessage("idle");
  };

  const handlePointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) {
      return;
    }
    const point = toCanvasPoint(event);
    if (!point) {
      return;
    }
    if (drag.shape === "rect") {
      setRectPos({ x: point.x - drag.offsetX, y: point.y - drag.offsetY });
    } else {
      setCircleCenter({ x: point.x - drag.offsetX, y: point.y - drag.offsetY });
    }
  };

  /**
   * Finishes a drag by hit-testing the shape center against the slots -
   * snapping into the matching slot, bouncing back off the wrong slot or a
   * miss - and, when no drag is in flight, treats the release as a click on
   * the painted Save button.
   */
  const handlePointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
    const point = toCanvasPoint(event);
    if (!point) {
      return;
    }
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) {
      handleSaveAttempt(point);
      return;
    }
    if (drag.shape === "rect") {
      const center = {
        x: rectPos.x + RECT_SIZE.width / 2,
        y: rectPos.y + RECT_SIZE.height / 2,
      };
      if (isInsideRectSlot(center)) {
        setRectPos(RECT_SLOT);
        setRectPlaced(true);
        return;
      }
      if (rectPos.x === RECT_HOME.x && rectPos.y === RECT_HOME.y) {
        return;
      }
      setRectPos(RECT_HOME);
      setMessage(isInsideCircleSlot(center) ? "wrong-slot" : "missed");
      return;
    }
    if (isInsideCircleSlot(circleCenter)) {
      setCircleCenter(CIRCLE_SLOT);
      setCirclePlaced(true);
      return;
    }
    if (circleCenter.x === CIRCLE_HOME.x && circleCenter.y === CIRCLE_HOME.y) {
      return;
    }
    setCircleCenter(CIRCLE_HOME);
    setMessage(isInsideRectSlot(circleCenter) ? "wrong-slot" : "missed");
  };

  /**
   * Handles a plain click on the painted toolbar: Save completes the design
   * once both shapes sit in their slots, otherwise it explains what is left.
   */
  const handleSaveAttempt = (point: Point) => {
    if (saved) {
      return;
    }
    const inSaveButton =
      point.x >= SAVE_BUTTON.x &&
      point.x <= SAVE_BUTTON.x + SAVE_BUTTON.width &&
      point.y >= SAVE_BUTTON.y &&
      point.y <= SAVE_BUTTON.y + SAVE_BUTTON.height;
    if (!inSaveButton) {
      return;
    }
    if (!rectPlaced || !circlePlaced) {
      setMessage("incomplete");
      return;
    }
    setSaved(true);
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
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
      />
    </div>
  );
}

/**
 * True when the point sits inside the dashed rectangle slot.
 */
function isInsideRectSlot(point: Point): boolean {
  return (
    point.x >= RECT_SLOT.x &&
    point.x <= RECT_SLOT.x + RECT_SIZE.width &&
    point.y >= RECT_SLOT.y &&
    point.y <= RECT_SLOT.y + RECT_SIZE.height
  );
}

/**
 * True when the point sits inside the dashed circle slot.
 */
function isInsideCircleSlot(point: Point): boolean {
  return Math.hypot(point.x - CIRCLE_SLOT.x, point.y - CIRCLE_SLOT.y) <= CIRCLE_RADIUS;
}

const MESSAGE_TEXT: Record<Exclude<Message, "idle">, string> = {
  "wrong-slot": "Wrong slot - shape returned to the shelf",
  missed: "Missed the slot - shape returned to the shelf",
  incomplete: "Place both shapes before saving",
};

type Scene = {
  rectPos: Point;
  circleCenter: Point;
  rectPlaced: boolean;
  circlePlaced: boolean;
  saved: boolean;
  message: Message;
};

/**
 * Repaints the whole whiteboard from state: toolbar with the Save button and
 * placement counter, instruction line, dashed slots, both shapes at their
 * current positions, and the status or saved banner.
 */
function redraw(context: CanvasRenderingContext2D, scene: Scene) {
  context.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  context.fillStyle = "#fff";
  context.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  context.fillStyle = "#f4f4f4";
  context.fillRect(0, 0, CANVAS_WIDTH, TOOLBAR_HEIGHT);
  context.strokeStyle = "#ddd";
  context.setLineDash([]);
  context.beginPath();
  context.moveTo(0, TOOLBAR_HEIGHT);
  context.lineTo(CANVAS_WIDTH, TOOLBAR_HEIGHT);
  context.stroke();

  context.fillStyle = "#111";
  context.font = "700 18px sans-serif";
  context.textAlign = "left";
  context.fillText("TA Whiteboard", 16, 35);

  const placedCount = Number(scene.rectPlaced) + Number(scene.circlePlaced);
  const saveActive = scene.rectPlaced && scene.circlePlaced && !scene.saved;
  context.fillStyle = saveActive ? "#2563eb" : "#ddd";
  context.beginPath();
  context.roundRect(SAVE_BUTTON.x, SAVE_BUTTON.y, SAVE_BUTTON.width, SAVE_BUTTON.height, 6);
  context.fill();
  context.fillStyle = saveActive ? "#fff" : "#888";
  context.font = "600 14px sans-serif";
  context.textAlign = "center";
  context.fillText(
    scene.saved ? "Saved" : `Save (${placedCount}/2)`,
    SAVE_BUTTON.x + SAVE_BUTTON.width / 2,
    SAVE_BUTTON.y + 21,
  );

  context.fillStyle = "#111";
  context.font = "600 15px sans-serif";
  context.textAlign = "center";
  context.fillText(
    "Drag each shape into its matching dashed slot, then press Save",
    CANVAS_WIDTH / 2,
    88,
  );

  context.setLineDash([6, 4]);
  context.lineWidth = 2;
  context.strokeStyle = scene.rectPlaced ? "#0a0" : "#888";
  context.strokeRect(RECT_SLOT.x, RECT_SLOT.y, RECT_SIZE.width, RECT_SIZE.height);
  context.strokeStyle = scene.circlePlaced ? "#0a0" : "#888";
  context.beginPath();
  context.arc(CIRCLE_SLOT.x, CIRCLE_SLOT.y, CIRCLE_RADIUS, 0, Math.PI * 2);
  context.stroke();
  context.setLineDash([]);
  context.lineWidth = 1;

  context.fillStyle = "#2563eb";
  context.fillRect(scene.rectPos.x, scene.rectPos.y, RECT_SIZE.width, RECT_SIZE.height);

  context.fillStyle = "#ea580c";
  context.beginPath();
  context.arc(scene.circleCenter.x, scene.circleCenter.y, CIRCLE_RADIUS, 0, Math.PI * 2);
  context.fill();

  if (scene.saved) {
    context.fillStyle = "#0a0";
    context.font = "600 22px sans-serif";
    context.textAlign = "center";
    context.fillText("Design saved", CANVAS_WIDTH / 2, 424);
    return;
  }
  if (scene.message !== "idle") {
    context.fillStyle = "#c00";
    context.font = "600 15px sans-serif";
    context.textAlign = "center";
    context.fillText(MESSAGE_TEXT[scene.message], CANVAS_WIDTH / 2, 424);
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
    width: 640,
    maxWidth: "100%",
    border: "1px solid #ccc",
    borderRadius: 8,
    touchAction: "none",
  },
} satisfies Record<string, CSSProperties>;
