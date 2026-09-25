/** A file download and a page tall enough that its footer needs scrolling to reach. */

const nav = [
  { path: '/downloads', label: 'Downloads' },
  { path: '/release-notes', label: 'Release notes' },
];

const pages = {
  '/downloads': () => ({
    title: 'Downloads',
    body: `<h1>Downloads</h1>
       <a href="/files/report.csv" download>Download report</a>`,
  }),

  '/release-notes': () => ({
    title: 'Release notes',
    body: `<h1>Release notes</h1>
       <p>A page tall enough to require scrolling before the footer is reachable.</p>
       <ol data-testid="notes">
         ${Array.from({ length: 60 }, (_, index) => `<li>Change number ${index + 1}</li>`).join('\n')}
       </ol>
       <button id="acknowledge">Acknowledge release notes</button>
       <output role="status" aria-label="Acknowledgement">not acknowledged</output>
       <script>
         document.getElementById('acknowledge').addEventListener('click', () => {
           document.querySelector('output').textContent = 'acknowledged';
         });
       </script>`,
  }),
};

/** This group's routes and the nav entries it contributes, in order. */
export const downloads = { nav, pages };
