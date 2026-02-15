import { spawn } from 'node:child_process';

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { cmd: null, times: 1 };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--cmd') {
      out.cmd = args[i + 1];
      i += 1;
    } else if (arg === '--times') {
      out.times = Number(args[i + 1] ?? '1');
      i += 1;
    }
  }
  if (!out.cmd) {
    throw new Error('runRepeated requires --cmd "<command>"');
  }
  if (!Number.isFinite(out.times) || out.times < 1) {
    throw new Error('runRepeated requires --times >= 1');
  }
  return out;
}

function runOnce(cmd, index) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, {
      stdio: 'inherit',
      shell: true,
      env: process.env
    });
    child.on('exit', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`runRepeated failed on iteration ${index + 1} (exit ${code})`));
    });
  });
}

const { cmd, times } = parseArgs();

for (let i = 0; i < times; i += 1) {
  console.log(`[runRepeated] run ${i + 1}/${times}: ${cmd}`);
  // eslint-disable-next-line no-await-in-loop
  await runOnce(cmd, i);
}
