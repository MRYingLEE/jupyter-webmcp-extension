/**
 * Decisions about which frames may run the runtime.
 *
 * A top-level document is governed by its enabled origin alone. An embedded
 * frame also needs the `tools` permission from its embedder, and every
 * ancestor must be an enabled origin, so an unrelated third-party page cannot
 * gain tools in an enabled page.
 */

interface IFeaturePolicyDocument {
  featurePolicy: { allowsFeature(feature: string): boolean };
}

/** Whether the frame's Permissions Policy allows the `tools` feature. */
export function allowsTools(doc: Document): boolean {
  try {
    return (doc as unknown as IFeaturePolicyDocument).featurePolicy.allowsFeature('tools');
  } catch {
    return false;
  }
}

/** Whether the MAIN-world hook may inject the runtime into a frame's configuration. */
export function mayInjectRuntime(input: { isTop: boolean; allowsTools: boolean }): boolean {
  return input.isTop || input.allowsTools;
}

export interface IGrantInput {
  isTop: boolean;
  allowsTools: boolean;
  /** The frame's own origin. */
  origin: string;
  /** The origins of the frame's ancestors. */
  ancestorOrigins: readonly string[];
  enabledOrigins: readonly string[];
}

/** Whether the isolated bridge may grant the runtime base URL to a frame. */
export function mayGrantRuntime(input: IGrantInput): boolean {
  if (input.isTop) {
    return true;
  }
  const enabled = (origin: string): boolean => input.enabledOrigins.includes(origin);
  return (
    input.allowsTools &&
    enabled(input.origin) &&
    input.ancestorOrigins.every(enabled)
  );
}
