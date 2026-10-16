/**
 * Remove spam folders from uploads/project-env.
 * Usage: npx tsx scripts/cleanup-project-env-spam.ts [--dry-run]
 */
import fs from 'fs';
import path from 'path';
import { isSpamProjectEnvFolder } from '../src/utils/spam-filter';

const PROJECT_ENV_DIR = path.normalize(path.join(process.cwd(), 'uploads', 'project-env'));
const dryRun = process.argv.includes('--dry-run');

function main(): void {
  if (!fs.existsSync(PROJECT_ENV_DIR)) {
    console.log(`Nothing to clean — ${PROJECT_ENV_DIR} does not exist`);
    return;
  }

  const entries = fs.readdirSync(PROJECT_ENV_DIR, { withFileTypes: true });
  const spamDirs = entries.filter((e) => e.isDirectory() && isSpamProjectEnvFolder(e.name));

  console.log(`${dryRun ? '[dry-run] ' : ''}Found ${spamDirs.length} spam folders in ${PROJECT_ENV_DIR}`);

  let removed = 0;
  for (const dir of spamDirs) {
    const fullPath = path.join(PROJECT_ENV_DIR, dir.name);
    if (dryRun) {
      console.log(`  would remove: ${dir.name}`);
    } else {
      fs.rmSync(fullPath, { recursive: true, force: true });
    }
    removed++;
    if (removed % 5000 === 0) {
      console.log(`  ...${removed} processed`);
    }
  }

  const remaining = fs.readdirSync(PROJECT_ENV_DIR).length;
  console.log(`${dryRun ? 'Would remove' : 'Removed'} ${removed} folders. Remaining: ${remaining}`);
}

main();
