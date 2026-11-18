/**
 * Tenant membership policy for the OS suite (SH-0271).
 * Port of meta `lib/os_suite/tenant_policy.py` — keep assertions in sync.
 */

export type Role = "owner" | "operator" | "reader";

export type Principal = {
  userId: string;
  tenants: ReadonlySet<string>; // e.g. {"letsloop"} or {"*"}
  role: Role;
};

export type Resource =
  | "revenue"
  | "crm"
  | "fleet"
  | "hookify_tenant"
  | "meeting";

export function canRead(
  principal: Principal,
  opts: { tenant: string; resource: Resource },
): boolean {
  const { tenant, resource } = opts;
  if (principal.tenants.has("*")) return true;
  if (!principal.tenants.has(tenant)) return false;
  // Tenant members may read tenant-scoped resources. `fleet` is estate-wide.
  if (resource === "fleet") return false;
  if (
    resource === "revenue" ||
    resource === "crm" ||
    resource === "hookify_tenant" ||
    resource === "meeting"
  ) {
    return true;
  }
  return false;
}

export function josh(): Principal {
  return {
    userId: "josh",
    tenants: new Set(["letsloop"]),
    role: "operator",
  };
}

export function adrien(): Principal {
  return {
    userId: "adrien",
    tenants: new Set(["*"]),
    role: "owner",
  };
}

const TENANT_ID = /^[a-z][a-z0-9_-]{0,63}$/;

/** Client portal principal — never accepts `*` or empty (would escalate to owner). */
export function clientPortal(tenant: string): Principal {
  const t = tenant.trim().toLowerCase();
  if (!t || t === "*" || !TENANT_ID.test(t)) {
    throw new Error(`invalid client tenant id: ${JSON.stringify(tenant)}`);
  }
  return {
    userId: `client:${t}`,
    tenants: new Set([t]),
    role: "reader",
  };
}

/** Fake-user header for tests while IdP is PARKED. */
export function principalFromHeader(
  value: string | null | undefined,
): Principal | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (v === "josh" || v === "joshua") return josh();
  if (v === "adrien") return adrien();
  if (v.startsWith("client:")) {
    const tenant = v.slice("client:".length);
    try {
      return clientPortal(tenant);
    } catch {
      return null;
    }
  }
  return null;
}

export function assertSuiteNegatives(): string[] {
  const fails: string[] = [];
  const j = josh();
  const a = adrien();
  const checks: Array<[boolean, string]> = [
    [
      !canRead(j, { tenant: "propersites", resource: "revenue" }),
      "Josh blocked ProperSites revenue",
    ],
    [
      !canRead(j, { tenant: "propersites", resource: "crm" }),
      "Josh blocked ProperSites CRM",
    ],
    [
      !canRead(j, { tenant: "propersites", resource: "fleet" }),
      "Josh blocked non-LetsLoop fleet",
    ],
    [
      !canRead(j, { tenant: "burnoutfounder", resource: "hookify_tenant" }),
      "Josh blocked other Hookify tenant",
    ],
    [
      !canRead(j, { tenant: "propersites", resource: "meeting" }),
      "Josh blocked non-LetsLoop meeting",
    ],
    [
      canRead(j, { tenant: "letsloop", resource: "meeting" }),
      "Josh can read LetsLoop meeting",
    ],
    [
      canRead(a, { tenant: "propersites", resource: "revenue" }),
      "Adrien can read ProperSites revenue",
    ],
    [
      canRead(a, { tenant: "propersites", resource: "crm" }),
      "Adrien can read CRM",
    ],
    [
      canRead(a, { tenant: "propersites", resource: "fleet" }),
      "Adrien can read fleet",
    ],
    [
      !canRead(clientPortal("letsloop"), {
        tenant: "propersites",
        resource: "crm",
      }),
      "Client cannot cross tenant",
    ],
  ];
  for (const [ok, label] of checks) {
    if (!ok) fails.push(label);
  }
  return fails;
}
