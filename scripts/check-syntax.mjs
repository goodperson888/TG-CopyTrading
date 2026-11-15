import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
for (const dir of ['src', 'scripts', 'public']) for (const file of readdirSync(dir)) if (/\.(mjs|js)$/.test(file)) execFileSync(process.execPath, ['--check', `${dir}/${file}`], { stdio: 'inherit' });
console.log('所有程序文件语法检查通过');
