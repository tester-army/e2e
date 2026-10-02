/** Links to a YouTube video in a new tab: thumbnail on the left, title and subtitle on the right. */
export const VideoCard = ({ id, title, subtitle }) => (
  <a
    className="video-card"
    href={`https://www.youtube.com/watch?v=${id}`}
    target="_blank"
    rel="noopener noreferrer"
  >
    <span className="video-card-thumbnail">
      <img src={`https://i.ytimg.com/vi/${id}/hqdefault.jpg`} alt="" loading="lazy" noZoom />
      <svg className="video-card-play" viewBox="0 0 48 48" aria-hidden="true">
        <circle cx="24" cy="24" r="24" fill="rgb(0 0 0 / 0.6)" />
        <path d="M19 15.5v17l14-8.5z" fill="#fff" />
      </svg>
    </span>
    <span className="video-card-text">
      <span className="video-card-title">{title}</span>
      <span className="video-card-subtitle">{subtitle}</span>
      <span className="video-card-new-tab"> (opens in a new tab)</span>
    </span>
    <svg
      className="video-card-arrow"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M7 17 17 7M7 7h10v10" />
    </svg>
  </a>
);
