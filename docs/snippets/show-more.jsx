/** Shows the start of its content in a hairline box, faded out over a "Show more" button that expands it. */
export const ShowMore = ({ id, children }) => {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="show-more" data-expanded={expanded}>
      <div id={id} className="show-more-content">
        {children}
      </div>
      <button
        type="button"
        className="show-more-toggle"
        aria-expanded={expanded}
        aria-controls={id}
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? 'Show less' : 'Show more'}
      </button>
    </div>
  );
};
