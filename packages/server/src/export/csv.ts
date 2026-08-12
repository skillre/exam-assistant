// 第四批 ①：CSV 生成（RFC4180 手写转义，不引入依赖）。
// 规则：字段含逗号/双引号/换行（\n \r）时整体加双引号，内部双引号翻倍；其余字段原样。
// 输出带 UTF-8 BOM（\uFEFF），Excel 打开中文不乱码。

export function csvCell(value: unknown): string {
	const s = value === null || value === undefined ? "" : String(value);
	if (/[",\r\n]/.test(s)) {
		return `"${s.replace(/"/g, '""')}"`;
	}
	return s;
}

/** 多行转 CSV 文本（含 BOM 头）。表头行放 rows[0]。 */
export function toCsv(rows: readonly (readonly unknown[])[]): string {
	const body = rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
	return `\uFEFF${body}\r\n`;
}

/** 导出文件名：exam-{bank}-YYYYMMDD.csv */
export function exportFilename(prefix: string, date = new Date()): string {
	const d = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
	return `exam-${prefix}-${d}.csv`;
}
