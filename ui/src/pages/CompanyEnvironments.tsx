import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AGENT_ADAPTER_TYPES,
  getAdapterEnvironmentSupport,
  type Environment,
  type EnvironmentProbeResult,
  type JsonSchema,
} from "@paperclipai/shared";
import { Check, Settings } from "lucide-react";
import { environmentsApi } from "@/api/environments";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { secretsApi } from "@/api/secrets";
import { Button } from "@/components/ui/button";
import { JsonSchemaForm, getDefaultValues, validateJsonSchemaForm } from "@/components/JsonSchemaForm";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import {
  Field,
  ToggleField,
  adapterLabels,
} from "../components/agent-config-primitives";

type EnvironmentFormState = {
  name: string;
  description: string;
  driver: "local" | "ssh" | "sandbox";
  sshHost: string;
  sshPort: string;
  sshUsername: string;
  sshRemoteWorkspacePath: string;
  sshPrivateKey: string;
  sshPrivateKeySecretId: string;
  sshKnownHosts: string;
  sshStrictHostKeyChecking: boolean;
  sandboxProvider: string;
  sandboxConfig: Record<string, unknown>;
};

const ENVIRONMENT_SUPPORT_ROWS = AGENT_ADAPTER_TYPES.map((adapterType) => ({
  adapterType,
  support: getAdapterEnvironmentSupport(adapterType),
}));

function buildEnvironmentPayload(form: EnvironmentFormState) {
  return {
    name: form.name.trim(),
    description: form.description.trim() || null,
    driver: form.driver,
    config:
      form.driver === "ssh"
        ? {
            host: form.sshHost.trim(),
            port: Number.parseInt(form.sshPort || "22", 10) || 22,
            username: form.sshUsername.trim(),
            remoteWorkspacePath: form.sshRemoteWorkspacePath.trim(),
            privateKey: form.sshPrivateKey.trim() || null,
            privateKeySecretRef:
              form.sshPrivateKey.trim().length > 0 || !form.sshPrivateKeySecretId
                ? null
                : { type: "secret_ref" as const, secretId: form.sshPrivateKeySecretId, version: "latest" as const },
            knownHosts: form.sshKnownHosts.trim() || null,
            strictHostKeyChecking: form.sshStrictHostKeyChecking,
          }
        : form.driver === "sandbox"
          ? {
              provider: form.sandboxProvider.trim(),
              ...form.sandboxConfig,
            }
          : {},
  } as const;
}

function createEmptyEnvironmentForm(): EnvironmentFormState {
  return {
    name: "",
    description: "",
    driver: "ssh",
    sshHost: "",
    sshPort: "22",
    sshUsername: "",
    sshRemoteWorkspacePath: "",
    sshPrivateKey: "",
    sshPrivateKeySecretId: "",
    sshKnownHosts: "",
    sshStrictHostKeyChecking: true,
    sandboxProvider: "",
    sandboxConfig: {},
  };
}

function readSshConfig(environment: Environment) {
  const config = environment.config ?? {};
  return {
    host: typeof config.host === "string" ? config.host : "",
    port:
      typeof config.port === "number"
        ? String(config.port)
        : typeof config.port === "string"
          ? config.port
          : "22",
    username: typeof config.username === "string" ? config.username : "",
    remoteWorkspacePath:
      typeof config.remoteWorkspacePath === "string" ? config.remoteWorkspacePath : "",
    privateKey: "",
    privateKeySecretId:
      config.privateKeySecretRef &&
      typeof config.privateKeySecretRef === "object" &&
      !Array.isArray(config.privateKeySecretRef) &&
      typeof (config.privateKeySecretRef as { secretId?: unknown }).secretId === "string"
        ? String((config.privateKeySecretRef as { secretId: string }).secretId)
        : "",
    knownHosts: typeof config.knownHosts === "string" ? config.knownHosts : "",
    strictHostKeyChecking:
      typeof config.strictHostKeyChecking === "boolean"
        ? config.strictHostKeyChecking
        : true,
  };
}

function readSandboxConfig(environment: Environment) {
  const config = environment.config ?? {};
  const { provider: rawProvider, ...providerConfig } = config;
  return {
    provider: typeof rawProvider === "string" && rawProvider.trim().length > 0
      ? rawProvider
      : "fake",
    config: providerConfig,
  };
}

function normalizeJsonSchema(schema: unknown): JsonSchema | null {
  return schema && typeof schema === "object" && !Array.isArray(schema)
    ? schema as JsonSchema
    : null;
}

function summarizeSandboxConfig(config: Record<string, unknown>): string | null {
  for (const key of ["template", "image", "region", "workspacePath"]) {
    const value = config[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

function SupportMark({ supported }: { supported: boolean }) {
  return supported ? (
    <span className="inline-flex items-center gap-1 text-green-700 dark:text-green-400">
      <Check className="h-3 w-3" />
      Yes
    </span>
  ) : (
    <span className="text-muted-foreground">No</span>
  );
}

export function CompanyEnvironments() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [editingEnvironmentId, setEditingEnvironmentId] = useState<string | null>(null);
  const [environmentForm, setEnvironmentForm] = useState<EnvironmentFormState>(createEmptyEnvironmentForm);
  const [probeResults, setProbeResults] = useState<Record<string, EnvironmentProbeResult | null>>({});

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Entreprise", href: "/dashboard" },
      { label: "Paramètres", href: "/company/settings" },
      { label: "Environnements" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
    retry: false,
  });
  const environmentsEnabled = experimentalSettings?.enableEnvironments === true;

  const { data: environments } = useQuery({
    queryKey: selectedCompanyId ? queryKeys.environments.list(selectedCompanyId) : ["environments", "none"],
    queryFn: () => environmentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId) && environmentsEnabled,
  });
  const { data: environmentCapabilities } = useQuery({
    queryKey: selectedCompanyId ? ["environment-capabilities", selectedCompanyId] : ["environment-capabilities", "none"],
    queryFn: () => environmentsApi.capabilities(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId) && environmentsEnabled,
  });

  const { data: secrets } = useQuery({
    queryKey: selectedCompanyId ? ["company-secrets", selectedCompanyId] : ["company-secrets", "none"],
    queryFn: () => secretsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const environmentMutation = useMutation({
    mutationFn: async (form: EnvironmentFormState) => {
      const body = buildEnvironmentPayload(form);

      if (editingEnvironmentId) {
        return await environmentsApi.update(editingEnvironmentId, body);
      }

      return await environmentsApi.create(selectedCompanyId!, body);
    },
    onSuccess: async (environment) => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.environments.list(selectedCompanyId!),
      });
      setEditingEnvironmentId(null);
      setEnvironmentForm(createEmptyEnvironmentForm());
      pushToast({
        title: editingEnvironmentId ? "Environnement mis à jour" : "Environnement créé",
        body: `${environment.name} est prêt.`,
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Échec de l'enregistrement de l'environnement",
        body: error instanceof Error ? error.message : "Échec de l'enregistrement de l'environnement.",
        tone: "error",
      });
    },
  });

  const environmentProbeMutation = useMutation({
    mutationFn: async (environmentId: string) => await environmentsApi.probe(environmentId),
    onSuccess: (probe, environmentId) => {
      setProbeResults((current) => ({
        ...current,
        [environmentId]: probe,
      }));
      pushToast({
        title: probe.ok ? "Test de l'environnement réussi" : "Test de l'environnement échoué",
        body: probe.summary,
        tone: probe.ok ? "success" : "error",
      });
    },
    onError: (error, environmentId) => {
      const failedEnvironment = (environments ?? []).find((environment) => environment.id === environmentId);
      setProbeResults((current) => ({
        ...current,
        [environmentId]: {
          ok: false,
          driver: failedEnvironment?.driver ?? "local",
          summary: error instanceof Error ? error.message : "Test de l'environnement échoué.",
          details: null,
        },
      }));
      pushToast({
        title: "Test de l'environnement échoué",
        body: error instanceof Error ? error.message : "Test de l'environnement échoué.",
        tone: "error",
      });
    },
  });

  const draftEnvironmentProbeMutation = useMutation({
    mutationFn: async (form: EnvironmentFormState) => {
      const body = buildEnvironmentPayload(form);
      return await environmentsApi.probeConfig(selectedCompanyId!, body);
    },
    onSuccess: (probe) => {
      pushToast({
        title: probe.ok ? "Test du brouillon réussi" : "Test du brouillon échoué",
        body: probe.summary,
        tone: probe.ok ? "success" : "error",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Test du brouillon échoué",
        body: error instanceof Error ? error.message : "Test de l'environnement échoué.",
        tone: "error",
      });
    },
  });

  useEffect(() => {
    setEditingEnvironmentId(null);
    setEnvironmentForm(createEmptyEnvironmentForm());
    setProbeResults({});
  }, [selectedCompanyId]);

  function handleEditEnvironment(environment: Environment) {
    setEditingEnvironmentId(environment.id);
    if (environment.driver === "ssh") {
      const ssh = readSshConfig(environment);
      setEnvironmentForm({
        ...createEmptyEnvironmentForm(),
        name: environment.name,
        description: environment.description ?? "",
        driver: "ssh",
        sshHost: ssh.host,
        sshPort: ssh.port,
        sshUsername: ssh.username,
        sshRemoteWorkspacePath: ssh.remoteWorkspacePath,
        sshPrivateKey: ssh.privateKey,
        sshPrivateKeySecretId: ssh.privateKeySecretId,
        sshKnownHosts: ssh.knownHosts,
        sshStrictHostKeyChecking: ssh.strictHostKeyChecking,
      });
      return;
    }

    if (environment.driver === "sandbox") {
      const sandbox = readSandboxConfig(environment);
      setEnvironmentForm({
        ...createEmptyEnvironmentForm(),
        name: environment.name,
        description: environment.description ?? "",
        driver: "sandbox",
        sandboxProvider: sandbox.provider,
        sandboxConfig: sandbox.config,
      });
      return;
    }

    setEnvironmentForm({
      ...createEmptyEnvironmentForm(),
      name: environment.name,
      description: environment.description ?? "",
      driver: "local",
    });
  }

  function handleCancelEnvironmentEdit() {
    setEditingEnvironmentId(null);
    setEnvironmentForm(createEmptyEnvironmentForm());
  }

  const discoveredPluginSandboxProviders = Object.entries(environmentCapabilities?.sandboxProviders ?? {})
    .filter(([provider, capability]) => provider !== "fake" && capability.supportsRunExecution)
    .map(([provider, capability]) => ({
      provider,
      displayName: capability.displayName || provider,
      description: capability.description,
      configSchema: normalizeJsonSchema(capability.configSchema),
    }))
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
  const sandboxCreationEnabled = discoveredPluginSandboxProviders.length > 0;
  const sandboxSupportVisible = sandboxCreationEnabled;
  const pluginSandboxProviders =
    environmentForm.sandboxProvider.trim().length > 0 &&
    environmentForm.sandboxProvider !== "fake" &&
    !discoveredPluginSandboxProviders.some((provider) => provider.provider === environmentForm.sandboxProvider)
      ? [
          ...discoveredPluginSandboxProviders,
          { provider: environmentForm.sandboxProvider, displayName: environmentForm.sandboxProvider, description: undefined, configSchema: null },
        ]
      : discoveredPluginSandboxProviders;

  const selectedSandboxProvider = pluginSandboxProviders.find(
    (provider) => provider.provider === environmentForm.sandboxProvider,
  ) ?? null;
  const selectedSandboxSchema = selectedSandboxProvider?.configSchema ?? null;
  const sandboxConfigErrors =
    environmentForm.driver === "sandbox" && selectedSandboxSchema
      ? validateJsonSchemaForm(selectedSandboxSchema as any, environmentForm.sandboxConfig)
      : {};

  useEffect(() => {
    if (environmentForm.driver !== "sandbox") return;
    if (environmentForm.sandboxProvider.trim().length > 0 && environmentForm.sandboxProvider !== "fake") return;
    const firstProvider = discoveredPluginSandboxProviders[0]?.provider;
    if (!firstProvider) return;
    const firstSchema = discoveredPluginSandboxProviders[0]?.configSchema;
    setEnvironmentForm((current) => (
      current.driver !== "sandbox" || (current.sandboxProvider.trim().length > 0 && current.sandboxProvider !== "fake")
        ? current
        : {
            ...current,
            sandboxProvider: firstProvider,
            sandboxConfig: firstSchema ? getDefaultValues(firstSchema as any) : {},
          }
    ));
  }, [discoveredPluginSandboxProviders, environmentForm.driver, environmentForm.sandboxProvider]);

  const environmentFormValid =
    environmentForm.name.trim().length > 0 &&
    (environmentForm.driver !== "ssh" ||
      (
        environmentForm.sshHost.trim().length > 0 &&
        environmentForm.sshUsername.trim().length > 0 &&
        environmentForm.sshRemoteWorkspacePath.trim().length > 0
      )) &&
    (environmentForm.driver !== "sandbox" ||
      environmentForm.sandboxProvider.trim().length > 0 &&
      environmentForm.sandboxProvider !== "fake" &&
      Object.keys(sandboxConfigErrors).length === 0);

  if (!selectedCompanyId) {
    return <div className="text-sm text-muted-foreground">Sélectionnez une entreprise pour gérer les environnements.</div>;
  }

  if (!environmentsEnabled) {
    return (
      <div className="max-w-3xl space-y-4">
        <div className="flex items-center gap-2">
          <Settings className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Environnements de l'entreprise</h1>
        </div>
        <div className="rounded-md border border-border px-4 py-4 text-sm text-muted-foreground">
          Activez les environnements dans les paramètres expérimentaux de l'instance pour gérer les cibles d'exécution de l'entreprise.
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl space-y-6" data-testid="company-settings-environments-section">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Settings className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Environnements de l'entreprise</h1>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Définissez des cibles d'exécution réutilisables pour les projets, les espaces de travail de tâches et les adaptateurs distants.
        </p>
      </div>

      <div className="space-y-4 rounded-md border border-border px-4 py-4">
        <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          Les choix d'environnement utilisent la même matrice de support d'adaptateurs que les paramètres par défaut des agents. SSH est toujours disponible pour les adaptateurs gérés à distance ; les environnements sandbox n'apparaissent que lorsqu'un plugin de fournisseur sandbox compatible est installé.
        </div>
        {sandboxCreationEnabled ? (
          <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            Fournisseurs sandbox installés :{" "}
            <span className="font-medium text-foreground">
              {discoveredPluginSandboxProviders.map((provider) => provider.displayName).join(", ")}
            </span>
            . Ce ne sont pas des types d'adaptateurs. Ils alimentent le pilote Sandbox pour les adaptateurs prenant en charge l'exécution sandbox.
          </div>
        ) : null}

        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-left text-xs">
            <caption className="sr-only">Prise en charge des environnements par adaptateur</caption>
            <thead className="border-b border-border text-muted-foreground">
              <tr>
                <th className="py-2 pr-3 font-medium">Adaptateur</th>
                <th className="px-3 py-2 font-medium">Local</th>
                <th className="px-3 py-2 font-medium">SSH</th>
                {sandboxSupportVisible ? (
                  <th className="px-3 py-2 font-medium">Sandbox via plugin</th>
                ) : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {(environmentCapabilities?.adapters.map((support) => ({
                adapterType: support.adapterType,
                support,
              })) ?? ENVIRONMENT_SUPPORT_ROWS).map(({ adapterType, support }) => (
                <tr key={adapterType}>
                  <td className="py-2 pr-3 font-medium">
                    {adapterLabels[adapterType] ?? adapterType}
                  </td>
                  <td className="px-3 py-2">
                    <SupportMark supported={support.drivers.local === "supported"} />
                  </td>
                  <td className="px-3 py-2">
                    <SupportMark supported={support.drivers.ssh === "supported"} />
                  </td>
                  {sandboxSupportVisible ? (
                    <td className="px-3 py-2">
                      <SupportMark
                        supported={discoveredPluginSandboxProviders.some((provider) =>
                          support.sandboxProviders[provider.provider] === "supported")}
                      />
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="space-y-3">
          {(environments ?? []).length === 0 ? (
            <div className="text-sm text-muted-foreground">Aucun environnement enregistré pour cette entreprise pour le moment.</div>
          ) : (
            (environments ?? []).map((environment) => {
              const probe = probeResults[environment.id] ?? null;
              const isEditing = editingEnvironmentId === environment.id;
              return (
                <div
                  key={environment.id}
                  className="rounded-md border border-border/70 px-3 py-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="text-sm font-medium">
                        {environment.name} <span className="text-muted-foreground">· {environment.driver}</span>
                      </div>
                      {environment.description ? (
                        <div className="text-xs text-muted-foreground">{environment.description}</div>
                      ) : null}
                      {environment.driver === "ssh" ? (
                        <div className="text-xs text-muted-foreground">
                          {typeof environment.config.host === "string" ? environment.config.host : "SSH host"} ·{" "}
                          {typeof environment.config.username === "string" ? environment.config.username : "user"}
                        </div>
                      ) : environment.driver === "sandbox" ? (
                        <div className="text-xs text-muted-foreground">
                          {(() => {
                            const provider =
                              typeof environment.config.provider === "string" ? environment.config.provider : "sandbox";
                            const displayName =
                              environmentCapabilities?.sandboxProviders?.[provider]?.displayName ?? provider;
                            const summary = summarizeSandboxConfig(environment.config as Record<string, unknown>);
                            return `${displayName} sandbox provider${summary ? ` · ${summary}` : ""}`;
                          })()}
                        </div>
                      ) : (
                        <div className="text-xs text-muted-foreground">S'exécute sur cet hôte Kovv-ia.</div>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {environment.driver !== "local" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => environmentProbeMutation.mutate(environment.id)}
                          disabled={environmentProbeMutation.isPending}
                        >
                          {environmentProbeMutation.isPending
                            ? "Test en cours..."
                            : environment.driver === "ssh"
                              ? "Tester la connexion"
                              : "Tester le fournisseur"}
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleEditEnvironment(environment)}
                      >
                        {isEditing ? "En cours de modification" : "Modifier"}
                      </Button>
                    </div>
                  </div>
                  {probe ? (
                    <div
                      className={
                        probe.ok
                          ? "mt-3 rounded border border-green-500/30 bg-green-500/5 px-2.5 py-2 text-xs text-green-700"
                          : "mt-3 rounded border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-xs text-destructive"
                      }
                    >
                      <div className="font-medium">{probe.summary}</div>
                      {probe.details?.error && typeof probe.details.error === "string" ? (
                        <div className="mt-1 font-mono text-[11px]">{probe.details.error}</div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>

        <div className="border-t border-border/60 pt-4">
          <div className="mb-3 text-sm font-medium">
            {editingEnvironmentId ? "Modifier l'environnement" : "Ajouter un environnement"}
          </div>
          <div className="space-y-3">
            <Field label="Nom" hint="Nom visible par l'opérateur pour cette cible d'exécution.">
              <input
                className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                type="text"
                value={environmentForm.name}
                onChange={(e) => setEnvironmentForm((current) => ({ ...current, name: e.target.value }))}
              />
            </Field>
            <Field label="Description" hint="Note optionnelle sur l'utilisation de cette machine.">
              <input
                className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                type="text"
                value={environmentForm.description}
                onChange={(e) => setEnvironmentForm((current) => ({ ...current, description: e.target.value }))}
              />
            </Field>
            <Field label="Pilote" hint="Local s'exécute sur cet hôte. SSH stocke une cible de machine distante. Sandbox stocke la configuration du fournisseur basé sur un plugin.">
              <select
                className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                value={environmentForm.driver}
                onChange={(e) =>
                  setEnvironmentForm((current) => ({
                    ...current,
                    sandboxProvider:
                      e.target.value === "sandbox"
                        ? current.sandboxProvider.trim() || discoveredPluginSandboxProviders[0]?.provider || ""
                        : current.sandboxProvider,
                    sandboxConfig:
                      e.target.value === "sandbox"
                        ? (
                            current.sandboxProvider.trim().length > 0 && current.driver === "sandbox"
                              ? current.sandboxConfig
                              : discoveredPluginSandboxProviders[0]?.configSchema
                                ? getDefaultValues(discoveredPluginSandboxProviders[0].configSchema as any)
                                : {}
                          )
                        : current.sandboxConfig,
                    driver:
                      e.target.value === "local"
                        ? "local"
                        : e.target.value === "sandbox"
                          ? "sandbox"
                          : "ssh",
                  }))}
              >
                <option value="ssh">SSH</option>
                {sandboxCreationEnabled || environmentForm.driver === "sandbox" ? (
                  <option value="sandbox">Sandbox</option>
                ) : null}
                <option value="local">Local</option>
              </select>
            </Field>

            {environmentForm.driver === "ssh" ? (
              <div className="grid gap-3 md:grid-cols-2">
                <Field label="Hôte" hint="Nom DNS ou adresse IP de la machine distante.">
                  <input
                    className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                    type="text"
                    value={environmentForm.sshHost}
                    onChange={(e) => setEnvironmentForm((current) => ({ ...current, sshHost: e.target.value }))}
                  />
                </Field>
                <Field label="Port" hint="Par défaut : 22.">
                  <input
                    className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                    type="number"
                    min={1}
                    max={65535}
                    value={environmentForm.sshPort}
                    onChange={(e) => setEnvironmentForm((current) => ({ ...current, sshPort: e.target.value }))}
                  />
                </Field>
                <Field label="Nom d'utilisateur" hint="Utilisateur de connexion SSH.">
                  <input
                    className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                    type="text"
                    value={environmentForm.sshUsername}
                    onChange={(e) => setEnvironmentForm((current) => ({ ...current, sshUsername: e.target.value }))}
                  />
                </Field>
                <Field label="Chemin du workspace distant" hint="Chemin absolu que Kovv-ia vérifiera lors des tests de connexion SSH.">
                  <input
                    className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                    type="text"
                    placeholder="/Users/paperclip/workspace"
                    value={environmentForm.sshRemoteWorkspacePath}
                    onChange={(e) =>
                      setEnvironmentForm((current) => ({ ...current, sshRemoteWorkspacePath: e.target.value }))}
                  />
                </Field>
                <Field label="Clé privée" hint="Clé privée PEM optionnelle. Laissez vide pour utiliser l'agent SSH du serveur ou le trousseau par défaut.">
                  <div className="space-y-2">
                    <select
                      className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                      value={environmentForm.sshPrivateKeySecretId}
                      onChange={(e) =>
                        setEnvironmentForm((current) => ({
                          ...current,
                          sshPrivateKeySecretId: e.target.value,
                          sshPrivateKey: e.target.value ? "" : current.sshPrivateKey,
                        }))}
                    >
                      <option value="">Aucun secret enregistré</option>
                      {(secrets ?? []).map((secret) => (
                        <option key={secret.id} value={secret.id}>{secret.name}</option>
                      ))}
                    </select>
                    <textarea
                      className="h-32 w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-xs font-mono outline-none"
                      value={environmentForm.sshPrivateKey}
                      disabled={!!environmentForm.sshPrivateKeySecretId}
                      onChange={(e) => setEnvironmentForm((current) => ({ ...current, sshPrivateKey: e.target.value }))}
                    />
                  </div>
                </Field>
                <Field label="Hôtes connus" hint="Bloc known_hosts optionnel utilisé lorsque la vérification stricte de la clé d'hôte est activée.">
                  <textarea
                    className="h-32 w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-xs font-mono outline-none"
                    value={environmentForm.sshKnownHosts}
                    onChange={(e) => setEnvironmentForm((current) => ({ ...current, sshKnownHosts: e.target.value }))}
                  />
                </Field>
                <div className="md:col-span-2">
                  <ToggleField
                    label="Vérification stricte de la clé d'hôte"
                    hint="Gardez cette option activée sauf si vous souhaitez délibérément désactiver l'acceptation de la clé d'hôte lors des tests."
                    checked={environmentForm.sshStrictHostKeyChecking}
                    onChange={(checked) =>
                      setEnvironmentForm((current) => ({ ...current, sshStrictHostKeyChecking: checked }))}
                  />
                </div>
              </div>
            ) : null}

            {environmentForm.driver === "sandbox" ? (
              <div className="space-y-3">
                <Field label="Fournisseur" hint="Les plugins de fournisseur sandbox compatibles avec l'exécution apparaissent ici.">
                  <select
                    className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                    value={environmentForm.sandboxProvider}
                    onChange={(e) => {
                      const nextProviderKey = e.target.value;
                      const nextProvider = pluginSandboxProviders.find((provider) => provider.provider === nextProviderKey) ?? null;
                      setEnvironmentForm((current) => ({
                        ...current,
                        sandboxProvider: nextProviderKey,
                        sandboxConfig:
                          current.sandboxProvider === nextProviderKey
                            ? current.sandboxConfig
                            : nextProvider?.configSchema
                              ? getDefaultValues(nextProvider.configSchema as any)
                              : {},
                      }));
                    }}
                  >
                    {pluginSandboxProviders.map((provider) => (
                      <option key={provider.provider} value={provider.provider}>
                        {provider.displayName}
                      </option>
                    ))}
                  </select>
                </Field>
                {selectedSandboxProvider?.description ? (
                  <div className="text-xs text-muted-foreground">
                    {selectedSandboxProvider.description}
                  </div>
                ) : null}
                {selectedSandboxSchema ? (
                  <JsonSchemaForm
                    schema={selectedSandboxSchema as any}
                    values={environmentForm.sandboxConfig}
                    onChange={(values) =>
                      setEnvironmentForm((current) => ({ ...current, sandboxConfig: values }))}
                    errors={sandboxConfigErrors}
                  />
                ) : (
                  <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                    Ce fournisseur ne déclare pas de champs de configuration supplémentaires.
                  </div>
                )}
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                onClick={() => environmentMutation.mutate(environmentForm)}
                disabled={environmentMutation.isPending || !environmentFormValid}
              >
                {environmentMutation.isPending
                  ? editingEnvironmentId
                    ? "Enregistrement..."
                    : "Création..."
                  : editingEnvironmentId
                    ? "Enregistrer l'environnement"
                    : "Créer l'environnement"}
              </Button>
              {editingEnvironmentId ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={handleCancelEnvironmentEdit}
                  disabled={environmentMutation.isPending}
                >
                  Annuler
                </Button>
              ) : null}
              {environmentForm.driver !== "local" ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => draftEnvironmentProbeMutation.mutate(environmentForm)}
                  disabled={draftEnvironmentProbeMutation.isPending || !environmentFormValid}
                >
                  {draftEnvironmentProbeMutation.isPending ? "Test en cours..." : "Tester le brouillon"}
                </Button>
              ) : null}
              {environmentMutation.isError ? (
                <span className="text-xs text-destructive">
                  {environmentMutation.error instanceof Error
                    ? environmentMutation.error.message
                    : "Échec de l'enregistrement de l'environnement"}
                </span>
              ) : null}
              {draftEnvironmentProbeMutation.data ? (
                <span className={draftEnvironmentProbeMutation.data.ok ? "text-xs text-green-600" : "text-xs text-destructive"}>
                  {draftEnvironmentProbeMutation.data.summary}
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
