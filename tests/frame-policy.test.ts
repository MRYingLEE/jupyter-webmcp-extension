import { describe, expect, it } from 'vitest';
import { mayGrantRuntime, mayInjectRuntime } from '../src/shared/frame-policy';

const enabled = ['http://localhost:8888', 'http://localhost:8890'];

describe('mayGrantRuntime', () => {
  it('grants a top-level enabled page without consulting tools permission', () => {
    expect(
      mayGrantRuntime({
        isTop: true,
        allowsTools: false,
        origin: 'http://localhost:8888',
        ancestorOrigins: [],
        enabledOrigins: enabled
      })
    ).toBe(true);
  });

  it('grants an embedded frame when tools is allowed and every origin is enabled', () => {
    expect(
      mayGrantRuntime({
        isTop: false,
        allowsTools: true,
        origin: 'http://localhost:8890',
        ancestorOrigins: ['http://localhost:8888'],
        enabledOrigins: enabled
      })
    ).toBe(true);
  });

  it('denies an embedded frame without the tools permission', () => {
    expect(
      mayGrantRuntime({
        isTop: false,
        allowsTools: false,
        origin: 'http://localhost:8890',
        ancestorOrigins: ['http://localhost:8888'],
        enabledOrigins: enabled
      })
    ).toBe(false);
  });

  it('denies an embedded frame whose ancestor origin is not enabled', () => {
    expect(
      mayGrantRuntime({
        isTop: false,
        allowsTools: true,
        origin: 'http://localhost:8890',
        ancestorOrigins: ['https://third-party.example'],
        enabledOrigins: enabled
      })
    ).toBe(false);
  });

  it('denies an embedded frame whose own origin is not enabled', () => {
    expect(
      mayGrantRuntime({
        isTop: false,
        allowsTools: true,
        origin: 'https://other.example',
        ancestorOrigins: ['http://localhost:8888'],
        enabledOrigins: enabled
      })
    ).toBe(false);
  });
});

describe('mayInjectRuntime', () => {
  it('injects into a top-level document', () => {
    expect(mayInjectRuntime({ isTop: true, allowsTools: false })).toBe(true);
  });

  it('does not inject into an embedded frame without the tools permission', () => {
    expect(mayInjectRuntime({ isTop: false, allowsTools: false })).toBe(false);
  });
});
