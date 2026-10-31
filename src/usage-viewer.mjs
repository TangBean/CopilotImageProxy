const defaultEndpoint = 'const DEFAULT_ENDPOINT = "http://localhost:4141/usage";';

const sessionTitlesScript = `<script>
fetch('/__session-titles')
  .then((response) => response.ok ? response.json() : {})
  .then((titles) => {
    const processed = new WeakMap();
    const update = () => {
      for (const cell of document.querySelectorAll('td')) {
        const previous = processed.get(cell);
        if (previous && previous.node === cell.firstChild && previous.title === cell.textContent && previous.id === cell.title) continue;
        const id = cell.textContent.trim();
        if (!Object.hasOwn(titles, id)) continue;
        const title = titles[id];
        cell.textContent = title;
        cell.title = id;
        processed.set(cell, { node: cell.firstChild, title, id });
      }
    };
    update();
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'characterData') {
          const cell = record.target.parentElement?.closest('td');
          if (cell) processed.delete(cell);
        }
      }
      update();
    }).observe(document.body, {
      childList: true, characterData: true, subtree: true,
    });
  })
  .catch(() => {});
</script>`;

export function rewriteUsageViewer(body, { host, port }) {
  const endpointStart = body.indexOf(defaultEndpoint);
  if (endpointStart < 0 || !body.includes('</body>')) return null;
  const authority = host === '::1' ? `[${host}]:${port}` : `${host}:${port}`;
  const endpoint = Buffer.from(`const DEFAULT_ENDPOINT = "http://${authority}/usage";`);
  const html = Buffer.concat([body.subarray(0, endpointStart), endpoint, body.subarray(endpointStart + defaultEndpoint.length)]);
  const bodyEnd = html.lastIndexOf('</body>');
  return Buffer.concat([html.subarray(0, bodyEnd), Buffer.from(sessionTitlesScript), html.subarray(bodyEnd)]);
}
