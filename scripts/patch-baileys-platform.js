
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

async function patchBaileys() {
  const entryFile = require.resolve('@whiskeysockets/baileys');
  const libraryDirectory = path.dirname(entryFile);

  const targetFile = path.join(
    libraryDirectory,
    'Utils',
    'validate-connection.js'
  );

  console.log('Checking Baileys compatibility...');
  console.log('Baileys entry:', entryFile);

  let source;

  try {
    source = await readFile(targetFile, 'utf8');
  } catch (error) {
    throw new Error(
      `Could not find Baileys validation file: ${targetFile}. ${error.message}`
    );
  }

  const alreadyPatched =
    /platform:\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.UserAgent\.Platform\.MACOS\b/;

  if (alreadyPatched.test(source)) {
    console.log('Baileys MACOS platform patch is already applied.');
    return;
  }

  const platformPattern =
    /(platform:\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.UserAgent\.Platform\.)WEB\b/;

  if (!platformPattern.test(source)) {
    throw new Error(
      'Expected Baileys WEB platform declaration was not found. No file was changed.'
    );
  }

  source = source.replace(
    platformPattern,
    '$1MACOS'
  );

  await writeFile(targetFile, source, 'utf8');

  console.log('SUCCESS: Baileys platform changed from WEB to MACOS.');
}

patchBaileys().catch(error => {
  console.error('BAILEYS PATCH FAILED:', error);
  process.exitCode = 1;
});
