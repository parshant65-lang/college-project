const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Generate zip filename with today's date
const today = new Date().toISOString().split('T')[0];
const zipName = `News_Backup_${today}.zip`;
const zipPath = path.join(__dirname, zipName);

console.log(`\n==========================================================`);
console.log(`📦 CREATING GOOGLE DRIVE BACKUP: ${zipName}`);
console.log(`==========================================================`);

try {
  // Check what files to include
  const items = [];
  if (fs.existsSync(path.join(__dirname, 'Data'))) items.push('Data');
  if (fs.existsSync(path.join(__dirname, 'history.txt'))) items.push('history.txt');

  if (items.length === 0) {
    console.log('⚠️ No Data/ or history.txt found to backup.');
    process.exit(0);
  }

  // Create standard .zip using native python3 zipfile module
  execSync(`python3 -m zipfile -c "${zipName}" ${items.join(' ')}`, { cwd: __dirname });

  const stats = fs.statSync(zipPath);
  const sizeKB = (stats.size / 1024).toFixed(1);
  const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
  const sizeStr = stats.size > 1024 * 1024 ? `${sizeMB} MB` : `${sizeKB} KB`;

  console.log(`\n✅ ZIP BACKUP CREATED SUCCESSFULLY!`);
  console.log(`   📁 File Name : ${zipName}`);
  console.log(`   📍 Location  : ${zipPath}`);
  console.log(`   ⚖️ File Size : ${sizeStr} (Super tiny!)`);
  console.log(`\n==========================================================`);
  console.log(`☁️  HOW TO UPLOAD TO GOOGLE DRIVE:`);
  console.log(`   1. Open https://drive.google.com in your browser`);
  console.log(`   2. Drag & Drop "${zipName}" into your Google Drive`);
  console.log(`   3. Done! 100% permanently safe on the cloud.`);
  console.log(`   💡 After uploading to Drive, you can safely delete local Data/ if you wish!`);
  console.log(`==========================================================\n`);
} catch (err) {
  console.error('❌ Failed to create zip:', err.message);
}
