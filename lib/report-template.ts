export const PTS_REPORT_TEMPLATE_VERSION = "pts-performance-v3-manager-leads-meta-result";

// Source-of-truth workbook: Example-Zvit | Performance.
// IMPORTANT: reports are created only by copying the master Google Sheet.
// We never rebuild formatting/styles from code and never edit the master itself.
// Google Drive copy preserves fills, fonts, borders, merged cells, row heights,
// column widths, number formats, alignment and all other sheet formatting.
// Data contract: B = manager-entered general leads, C = Meta Result, E = Meta spend.
export const PTS_REPORT_TEMPLATE = {
  range: "A1:R168",
  titleCell: "A1",
  periodStartCell: "B2",
  periodEndCell: "D2",
  focusCell: "F2",
  weekly: {
    titleRow: 5,
    headerRow: 6,
    dataStartRow: 7,
    dataEndRow: 23,
  },
  daily: {
    sectionTitleRow: 27,
    blocks: [
      { dateRow: 29, headerRow: 30, dataStartRow: 31, dataEndRow: 47 },
      { dateRow: 50, headerRow: 51, dataStartRow: 52, dataEndRow: 68 },
      { dateRow: 70, headerRow: 71, dataStartRow: 72, dataEndRow: 88 },
      { dateRow: 90, headerRow: 91, dataStartRow: 92, dataEndRow: 108 },
      { dateRow: 110, headerRow: 111, dataStartRow: 112, dataEndRow: 128 },
      { dateRow: 130, headerRow: 131, dataStartRow: 132, dataEndRow: 148 },
      { dateRow: 150, headerRow: 151, dataStartRow: 152, dataEndRow: 168 },
    ],
  },
  dynamicColumns: {
    finalGoal: "O",
    finalGoalConversion: "P",
  },
} as const;

export type DailyBlock = { dateRow: number; headerRow: number; dataStartRow: number; dataEndRow: number };

// The master contains seven daily sections. Our fixed monthly cadence is
// 01–07, 08–15, 16–22 and 23–month-end, so the 2nd period needs 8 daily
// sections and the final period can need up to 9. Extra sections are appended
// by copying the last master daily block and follow a 20-row stride.
export function dailyBlocksForDays(days: number): DailyBlock[] {
  const base = PTS_REPORT_TEMPLATE.daily.blocks.map((block) => ({ ...block })) as DailyBlock[];
  const needed = Math.max(1, Math.min(9, days));
  while (base.length < needed) {
    const previous = base[base.length - 1];
    base.push({
      dateRow: previous.dateRow + 20,
      headerRow: previous.headerRow + 20,
      dataStartRow: previous.dataStartRow + 20,
      dataEndRow: previous.dataEndRow + 20,
    });
  }
  return base.slice(0, needed);
}

// Reference palette extracted from the workbook. This is documentation/validation only;
// generation must still use Drive copy rather than recreating these styles in code.
export const PTS_REPORT_STYLE_REFERENCE = {
  fontFamily: "Arial",
  headerDarkTeal: "#0B2F38",
  metaGold: "#D0A254",
  sectionGray: "#414141",
  dateBlack: "#000000",
  softPink: "#F7ECEF",
  softGreen: "#E6F1E9",
  softGreenAlt: "#E1EFE6",
  gridBorder: "#D5D5D5",
  white: "#FFFFFF",
  headerFontSize: 8,
  bodyFontSize: 9,
} as const;

export function dynamicGoalHeaderCells(days = 7) {
  const rows = [
    PTS_REPORT_TEMPLATE.weekly.headerRow,
    ...dailyBlocksForDays(days).map((block) => block.headerRow),
  ];
  return rows.flatMap((row) => [
    `${PTS_REPORT_TEMPLATE.dynamicColumns.finalGoal}${row}`,
    `${PTS_REPORT_TEMPLATE.dynamicColumns.finalGoalConversion}${row}`,
  ]);
}
