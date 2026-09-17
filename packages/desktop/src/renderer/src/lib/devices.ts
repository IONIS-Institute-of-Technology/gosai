/** The value of a device `<select>`: an index, or `''` for the default device. */
export function deviceFromSelectValue(value: string): number | null {
  if (value === '') return null;
  const index = Number.parseInt(value, 10);
  return Number.isSafeInteger(index) ? index : null;
}

export function deviceToSelectValue(device: number | null | undefined): string {
  return device == null ? '' : String(device);
}
