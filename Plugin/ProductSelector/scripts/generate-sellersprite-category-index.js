const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const pluginDir = path.join(__dirname, '..');
const sourcePath = path.join(pluginDir, '卖家精灵-NODE IDtree.xlsx');
const outputPath = path.join(pluginDir, 'data', 'sellersprite-category-index.json');

function cellText(row, index) {
  const value = row.getCell(index).value;
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

async function main() {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(sourcePath);
  const worksheet = workbook.getWorksheet('全部节点');
  if (!worksheet) throw new Error('Worksheet "全部节点" not found.');

  const headers = worksheet.getRow(1).values.slice(1).map(value => String(value || '').trim());
  const column = Object.fromEntries(headers.map((header, index) => [header, index + 1]));
  const required = ['node_id', '深度', '商品数', '是否叶节点', '完整英文路径', '完整中文路径', '完整id路径', 'level1_en', 'level1_cn'];
  for (const key of required) {
    if (!column[key]) throw new Error(`Missing required column: ${key}`);
  }

  const categories = [];
  const topCategories = new Map();
  let leafCategories = 0;

  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const nodeIdPath = cellText(row, column['完整id路径']);
    if (!nodeIdPath) continue;
    const isLeaf = cellText(row, column['是否叶节点']).toUpperCase() === 'Y';
    if (isLeaf) leafCategories += 1;

    const topNodeId = nodeIdPath.split(':')[0];
    const topEn = cellText(row, column.level1_en);
    const topCn = cellText(row, column.level1_cn);
    if (topNodeId && !topCategories.has(topNodeId)) {
      topCategories.set(topNodeId, { nodeId: topNodeId, en: topEn, cn: topCn });
    }

    categories.push({
      nodeId: cellText(row, column.node_id),
      nodeIdPath,
      enPath: cellText(row, column['完整英文路径']),
      cnPath: cellText(row, column['完整中文路径']),
      depth: Number(cellText(row, column['深度'])) || nodeIdPath.split(':').length,
      isLeaf,
      productCount: Number(cellText(row, column['商品数'])) || 0,
      topNodeId,
      topEn,
      topCn
    });
  }

  const payload = {
    source: path.basename(sourcePath),
    generatedAt: new Date().toISOString(),
    totalCategories: categories.length,
    leafCategories,
    topCategories: Array.from(topCategories.values()),
    categories
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${categories.length} SellerSprite categories to ${outputPath}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
