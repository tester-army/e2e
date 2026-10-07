/**
 * A muted, looping clip in a hairline frame with its caption underneath. It
 * plays on its own unless the reader prefers reduced motion; the controls
 * are always there.
 */
export const Video = ({ src, label, children }) => {
  const video = useRef(null);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: no-preference)').matches) {
      video.current?.play().catch(() => {});
    }
  }, []);

  return (
    <div className="video-figure">
      <video ref={video} src={src} aria-label={label} muted loop playsInline controls />
      <div className="video-figure-caption">{children}</div>
    </div>
  );
};
