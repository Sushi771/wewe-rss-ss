// Loaded only into an isolated HTTP rehearsal process. No real credentials or network.
const fs = require('node:fs');
const { cassette } = require('./album-acceptance-rehearsal.cjs');
const replay = cassette(process.env.ALBUM_QA_MANIFEST);
const persist = () =>
  fs.writeFileSync(
    process.env.ALBUM_QA_NETWORK_REPORT,
    JSON.stringify({
      ...replay.counts(),
      boundary: 'real saved responses; external network disabled',
      externalNetworkDisabled: true,
      savedAt: new Date().toISOString(),
    }),
  );
persist();
setInterval(persist, 250).unref();
process.on('exit', persist);
