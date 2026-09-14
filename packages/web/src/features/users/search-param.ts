/** Normalize @solidjs/router search param values to optional strings. */
export function searchParamValue(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === "" ? undefined : raw;
}
