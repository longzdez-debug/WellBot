const { execFileSync } = require('node:child_process');
const { copyFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

function run(command, args) {
  console.log(`[WellBOT] ${command} ${args.join(' ')}`);
  execFileSync(command, args, { stdio: 'inherit', cwd: __dirname });
}

try {
  run('npm', ['run', 'build']);
  mkdirSync(join(__dirname, 'dist', 'database'), { recursive: true });
  copyFileSync(
    join(__dirname, 'src', 'database', 'schema.sql'),
    join(__dirname, 'dist', 'database', 'schema.sql'),
  );
  console.log('[WellBOT] Build complete. Starting application...');
  require('./dist/index.js');
} catch (error) {
  console.error('[WellBOT] Startup failed:', error);
  process.exit(1);
}
