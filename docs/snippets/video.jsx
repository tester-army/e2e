/**
 * A muted, looping clip in a hairline frame with its caption underneath. It
 * plays on its own unless the reader prefers reduced motion; the controls
 * are always there.
 *
 * The page writes the `<video>` element itself, followed by the caption:
 * Mintlify resolves the `src` of a `<video>` in MDX to the deployed asset,
 * but never a prop passed to a custom component, so `src="/images/x.mp4"`
 * as a prop 404s wherever the docs are served under a subpath (`/docs`).
 */
export const Video = ({ children }) => {
  const figure = useRef(null);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: no-preference)').matches) {
      figure.current?.querySelector('video')?.play().catch(() => {});
    }
  }, []);

  return (
    <div ref={figure} className="video-figure">
      {children}
    </div>
  );
};
