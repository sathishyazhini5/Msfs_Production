// Accept current master labels and legacy dashboard spellings.
export const scholasticTypeNames = {
  NOVICE: ["novice", "novices", "novoices"],
  MINOR_SEMINARIAN: ["minor seminarian", "minor seminarians"],
};

export const scholasticDashboardType = (name) => {
  const normalized = String(name || "").trim().toLowerCase();
  if (scholasticTypeNames.NOVICE.includes(normalized)) return "novoices";
  if (scholasticTypeNames.MINOR_SEMINARIAN.includes(normalized)) return "minor seminarians";
  return normalized;
};
