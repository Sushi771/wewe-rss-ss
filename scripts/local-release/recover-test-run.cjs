// Explicit offline recovery; never kills an owner or removes unknown files.
const { parseArgs } = require('node:util');
const { recover } = require('./test-artifacts.cjs');
if (require.main === module) {
  try {
    const { values } = parseArgs({
      options: {
        root: { type: 'string' },
        audit: { type: 'string' },
        'confirm-children-stopped': { type: 'boolean', default: false },
      },
    });
    if (!values.root || !values.audit)
      throw new Error('Specify --root and --audit from run-manifest.json');
    console.log(
      JSON.stringify(
        recover({
          root: values.root,
          audit: values.audit,
          confirmChildrenStopped: values['confirm-children-stopped'],
        }),
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
