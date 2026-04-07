#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');
const { execSync } = require('child_process');
const readline = require('readline');

// ANSI colors
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  bold: '\x1b[1m',
  dim: '\x1b[2m'
};

const SIZE_CATEGORIES = {
  massive: { min: 2 * 1024 * 1024 * 1024, label: '>2GB', color: colors.red },
  huge: { min: 1 * 1024 * 1024 * 1024, label: '1-2GB', color: colors.yellow },
  large: { min: 500 * 1024 * 1024, label: '500MB-1GB', color: colors.cyan }
};

// Format bytes to human readable
function formatSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unitIndex = 0;
  
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  
  return `${size.toFixed(2)} ${units[unitIndex]}`;
}

// Get ACTUAL disk usage (handles sparse files like Docker)
async function getActualSize(filePath) {
  try {
    // Use 'du' command to get actual disk usage (handles sparse files)
    const output = execSync(`du -k "${filePath}" 2>/dev/null`, { encoding: 'utf8' });
    const actualKB = parseInt(output.split('\t')[0]);
    return actualKB * 1024; // Convert to bytes
  } catch (err) {
    // Fallback to stat if du fails
    try {
      const stats = await fs.stat(filePath);
      return stats.size;
    } catch {
      return 0;
    }
  }
}

// ASCII bar chart
function drawBar(percentage, width = 30) {
  const filled = Math.round((percentage / 100) * width);
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

// Scan directory recursively
async function scanDirectory(dirPath, results = [], progress = { count: 0 }) {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      
      // Skip system/protected dirs
      if (entry.name.startsWith('.') || 
          fullPath.includes('Library/Mobile Documents') ||
          fullPath.includes('System Volume Information') ||
          fullPath.includes('/Trash/')) {
        continue;
      }
      
      try {
        if (entry.isDirectory()) {
          await scanDirectory(fullPath, results, progress);
        } else if (entry.isFile()) {
          progress.count++;
          if (progress.count % 100 === 0) {
            process.stdout.write(`\r${colors.gray}Scanned ${progress.count} files...${colors.reset}`);
          }
          
          const stats = await fs.stat(fullPath);
          
          // Only check files > 500MB (reported size)
          if (stats.size >= SIZE_CATEGORIES.large.min) {
            const actualSize = await getActualSize(fullPath);
            
            // Only track if actual disk usage is > 500MB
            if (actualSize >= SIZE_CATEGORIES.large.min) {
              results.push({
                path: fullPath,
                reportedSize: stats.size,
                actualSize: actualSize,
                modified: stats.mtime,
                isSparse: stats.size > actualSize * 1.5 // Flag sparse files
              });
            }
          }
        }
      } catch (err) {
        // Skip permission denied files
        if (err.code !== 'EACCES' && err.code !== 'EPERM') {
          // Silent skip
        }
      }
    }
  } catch (err) {
    if (err.code !== 'EACCES' && err.code !== 'EPERM') {
      // Silent skip
    }
  }
  
  return results;
}

// Categorize files by ACTUAL size
function categorizeFiles(files) {
  const categorized = {
    massive: [],
    huge: [],
    large: []
  };
  
  files.forEach(file => {
    const size = file.actualSize;
    if (size >= SIZE_CATEGORIES.massive.min) {
      categorized.massive.push(file);
    } else if (size >= SIZE_CATEGORIES.huge.min) {
      categorized.huge.push(file);
    } else {
      categorized.large.push(file);
    }
  });
  
  return categorized;
}

// Display results with ASCII art
function displayResults(categorized) {
  console.log(`\n\n${colors.bold}${colors.cyan}╔════════════════════════════════════════════════╗${colors.reset}`);
  console.log(`${colors.bold}${colors.cyan}║        🗑️  DISK SPACE HUNTER v2.0 🗑️          ║${colors.reset}`);
  console.log(`${colors.bold}${colors.cyan}╚════════════════════════════════════════════════╝${colors.reset}\n`);
  
  let totalActualSize = 0;
  let totalFiles = 0;
  const allFiles = [];
  
  Object.entries(categorized).forEach(([category, files]) => {
    if (files.length === 0) return;
    
    const categoryConfig = SIZE_CATEGORIES[category];
    const categorySize = files.reduce((sum, f) => sum + f.actualSize, 0);
    totalActualSize += categorySize;
    totalFiles += files.length;
    
    console.log(`${colors.bold}${categoryConfig.color}${categoryConfig.label}${colors.reset} - ${files.length} files (${formatSize(categorySize)})`);
    console.log(`${colors.gray}${'─'.repeat(80)}${colors.reset}`);
    
    // Sort by actual size descending
    const sorted = files.sort((a, b) => b.actualSize - a.actualSize).slice(0, 15);
    const maxSize = sorted[0].actualSize;
    
    sorted.forEach((file, idx) => {
      const fileNum = allFiles.length + 1;
      allFiles.push(file);
      
      const sizeStr = formatSize(file.actualSize).padEnd(12);
      const bar = drawBar((file.actualSize / maxSize) * 100, 25);
      const sparseFlag = file.isSparse ? `${colors.dim}(sparse)${colors.reset}` : '';
      const shortPath = file.path.length > 70 ? '...' + file.path.slice(-67) : file.path;
      
      console.log(`${colors.gray}[${fileNum.toString().padStart(2)}]${colors.reset} ${categoryConfig.color}${bar}${colors.reset} ${sizeStr} ${sparseFlag}`);
      console.log(`     ${colors.dim}${shortPath}${colors.reset}`);
    });
    
    console.log('');
  });
  
  console.log(`${colors.bold}${colors.green}TOTAL: ${totalFiles} files = ${formatSize(totalActualSize)} actual disk usage${colors.reset}\n`);
  
  return allFiles;
}

// Interactive selection menu
async function interactiveMenu(allFiles) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  const question = (query) => new Promise(resolve => rl.question(query, resolve));
  
  const selected = new Set();
  
  console.log(`${colors.cyan}╔════════════════════════════════════════════════╗${colors.reset}`);
  console.log(`${colors.cyan}║              SELECTION MENU                    ║${colors.reset}`);
  console.log(`${colors.cyan}╚════════════════════════════════════════════════╝${colors.reset}\n`);
  console.log(`${colors.yellow}Commands:${colors.reset}`);
  console.log(`  ${colors.green}[num]${colors.reset}       - Toggle file (e.g., "1,3,5" or "1-10")`);
  console.log(`  ${colors.green}all${colors.reset}         - Select all files`);
  console.log(`  ${colors.green}none${colors.reset}        - Deselect all`);
  console.log(`  ${colors.green}show${colors.reset}        - Show current selection`);
  console.log(`  ${colors.green}delete${colors.reset}      - Delete selected files`);
  console.log(`  ${colors.green}q${colors.reset}           - Quit\n`);
  
  while (true) {
    const selectionInfo = selected.size > 0 
      ? `${colors.green}[${selected.size} selected]${colors.reset}` 
      : `${colors.gray}[none]${colors.reset}`;
    
    const answer = (await question(`${selectionInfo} ${colors.cyan}>${colors.reset} `)).trim().toLowerCase();
    
    if (answer === 'q' || answer === 'quit') {
      rl.close();
      console.log(`${colors.yellow}\nAborted. No files deleted.${colors.reset}`);
      return;
    }
    
    if (answer === 'all') {
      allFiles.forEach((_, idx) => selected.add(idx));
      console.log(`${colors.green}✓ Selected all ${allFiles.length} files${colors.reset}`);
      continue;
    }
    
    if (answer === 'none') {
      selected.clear();
      console.log(`${colors.yellow}✓ Cleared selection${colors.reset}`);
      continue;
    }
    
    if (answer === 'show') {
      if (selected.size === 0) {
        console.log(`${colors.gray}No files selected${colors.reset}`);
      } else {
        console.log(`\n${colors.bold}Selected files:${colors.reset}`);
        Array.from(selected).sort((a, b) => a - b).forEach(idx => {
          const file = allFiles[idx];
          console.log(`  ${colors.green}[${idx + 1}]${colors.reset} ${formatSize(file.actualSize).padEnd(12)} ${colors.dim}${file.path}${colors.reset}`);
        });
        const totalSize = Array.from(selected).reduce((sum, idx) => sum + allFiles[idx].actualSize, 0);
        console.log(`\n  ${colors.bold}Total: ${formatSize(totalSize)}${colors.reset}\n`);
      }
      continue;
    }
    
    if (answer === 'delete') {
      if (selected.size === 0) {
        console.log(`${colors.red}No files selected!${colors.reset}`);
        continue;
      }
      
      const toDelete = Array.from(selected).map(idx => allFiles[idx]);
      const totalSize = toDelete.reduce((sum, f) => sum + f.actualSize, 0);
      
      console.log(`\n${colors.red}${colors.bold}⚠️  ABOUT TO DELETE ${toDelete.length} FILES (${formatSize(totalSize)})${colors.reset}`);
      toDelete.forEach(f => console.log(`  ${colors.gray}- ${f.path}${colors.reset}`));
      
      const confirm = await question(`\n${colors.yellow}Type 'DELETE' to confirm: ${colors.reset}`);
      
      if (confirm === 'DELETE') {
        console.log(`\n${colors.cyan}Deleting files...${colors.reset}\n`);
        let deletedSize = 0;
        let deletedCount = 0;
        
        for (const file of toDelete) {
          try {
            await fs.unlink(file.path);
            deletedSize += file.actualSize;
            deletedCount++;
            console.log(`${colors.green}✓${colors.reset} ${formatSize(file.actualSize).padEnd(12)} ${colors.gray}${file.path}${colors.reset}`);
          } catch (err) {
            console.log(`${colors.red}✗${colors.reset} ${colors.red}FAILED: ${file.path}${colors.reset}`);
            console.log(`  ${colors.dim}${err.message}${colors.reset}`);
          }
        }
        
        console.log(`\n${colors.bold}${colors.green}🎉 Freed ${formatSize(deletedSize)} (${deletedCount}/${toDelete.length} files)!${colors.reset}\n`);
        rl.close();
        return;
      } else {
        console.log(`${colors.yellow}Cancelled.${colors.reset}`);
      }
      continue;
    }
    
    // Parse number selections
    try {
      const ranges = answer.split(',').map(s => s.trim());
      let toggled = 0;
      
      for (const range of ranges) {
        if (range.includes('-')) {
          const [start, end] = range.split('-').map(n => parseInt(n.trim()));
          for (let i = start; i <= end; i++) {
            if (i >= 1 && i <= allFiles.length) {
              const idx = i - 1;
              if (selected.has(idx)) {
                selected.delete(idx);
              } else {
                selected.add(idx);
              }
              toggled++;
            }
          }
        } else {
          const num = parseInt(range);
          if (num >= 1 && num <= allFiles.length) {
            const idx = num - 1;
            if (selected.has(idx)) {
              selected.delete(idx);
              console.log(`${colors.yellow}− Deselected [${num}]${colors.reset}`);
            } else {
              selected.add(idx);
              console.log(`${colors.green}+ Selected [${num}]${colors.reset}`);
            }
            toggled++;
          }
        }
      }
      
      if (toggled === 0) {
        console.log(`${colors.red}Invalid selection. Try: 1,3,5 or 1-10${colors.reset}`);
      }
    } catch (err) {
      console.log(`${colors.red}Invalid input. Type 'help' for commands.${colors.reset}`);
    }
  }
}

// Main
async function main() {
  const scanPath = process.argv[2] || process.env.HOME;
  
  console.log(`${colors.cyan}${colors.bold}Scanning ${scanPath}...${colors.reset}`);
  console.log(`${colors.gray}(Getting actual disk usage - this might take a few minutes)${colors.reset}\n`);
  
  const files = await scanDirectory(scanPath);
  const categorized = categorizeFiles(files);
  
  const allFiles = displayResults(categorized);
  
  if (allFiles.length === 0) {
    console.log(`${colors.green}No large files found! Disk is clean 🎉${colors.reset}`);
    return;
  }
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  rl.question(`${colors.yellow}Open selection menu? (y/n) ${colors.reset}`, async (answer) => {
    rl.close();
    if (answer.toLowerCase() === 'y') {
      await interactiveMenu(allFiles);
    } else {
      console.log(`${colors.gray}Done. Run again with 'y' to delete files.${colors.reset}`);
    }
  });
}

main().catch(err => {
  console.error(`${colors.red}Fatal error: ${err.message}${colors.reset}`);
  process.exit(1);
});