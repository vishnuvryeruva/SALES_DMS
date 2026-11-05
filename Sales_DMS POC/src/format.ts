export const qty = (value: number | null | undefined) =>
  value === null || value === undefined ? '-' : value.toLocaleString('en-US', { maximumFractionDigits: 3 });

export const shortDate = (iso: string | null | undefined) => {
  if (!iso) return '-';
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
};

export const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export const dateTime = (iso: string) =>
  new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
