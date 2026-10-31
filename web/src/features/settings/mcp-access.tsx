import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@shared/ui/button";
import { Input } from "@shared/ui/input";
import { Field, FieldLabel } from "@shared/ui/field";
import { api } from "@/lib/api";
import { Section } from "../studio/section";

interface Token {
  id: string;
  name: string;
  prefix: string;
  expires_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}
export function MCPAccess() {
  const qc = useQueryClient(),
    [name, setName] = useState(""),
    [secret, setSecret] = useState<{ id: string; token: string } | null>(null),
    [now] = useState(() => Date.now());
  const [copied, setCopied] = useState(""),
    [copyError, setCopyError] = useState(false);
  const query = useQuery({
    queryKey: ["mcp-tokens"],
    queryFn: () => api<{ endpoint: string; tokens: Token[] }>("/v1/mcp/tokens"),
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["mcp-tokens"] });
  const create = useMutation({
    mutationFn: () =>
      api<{ id: string; token: string }>("/v1/mcp/tokens", { body: { name } }),
    onSuccess: (value) => {
      setSecret(value);
      setName("");
      refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      api(`/v1/mcp/tokens/${id}`, { method: "DELETE" }),
    onSuccess: (_, id) => {
      if (secret?.id === id) setSecret(null);
      refresh();
    },
  });
  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  };
  return (
    <Section
      title="MCP access"
      description="Let an agent start and manage your coding sessions."
    >
      <div className="flex flex-col gap-4 border-t border-border p-5 max-md:p-4">
        {query.isPending ? (
          <p className="text-sm text-muted-foreground">Loading MCP access…</p>
        ) : query.isError ? (
          <p role="alert" className="text-sm text-failed">
            Couldn't load MCP access.
          </p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3">
              <code className="min-w-0 break-all text-xs">
                {query.data.endpoint}
              </code>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void copy(query.data.endpoint, "Address")}
              >
                {copied === "Address" ? "Copied" : "Copy address"}
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">
              Tokens can access all your sessions and use your connected models.
              They expire after 90 days.
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                setCopied("");
                create.mutate();
              }}
              className="flex flex-col gap-2"
            >
              <Field>
                <FieldLabel htmlFor="mcp-token-name">Token name</FieldLabel>
                <div className="flex gap-2 max-sm:flex-col">
                  <Input
                    id="mcp-token-name"
                    placeholder="My coding agent"
                    value={name}
                    maxLength={80}
                    onChange={(event) => setName(event.target.value)}
                    required
                  />
                  <Button
                    type="submit"
                    disabled={!name.trim() || create.isPending || !!secret}
                  >
                    {create.isPending ? "Creating…" : "Create token"}
                  </Button>
                </div>
              </Field>
            </form>
            {secret && (
              <div
                className="flex flex-col gap-3 rounded-md border border-border-strong bg-background p-4"
                role="status"
              >
                <p className="text-sm">
                  Copy your token now. You won't be able to see it again.
                </p>
                <Input
                  aria-label="New MCP token"
                  value={secret.token}
                  readOnly
                  autoComplete="off"
                  spellCheck={false}
                  onFocus={(event) => event.target.select()}
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void copy(secret.token, "Token")}
                  >
                    {copied === "Token" ? "Copied" : "Copy token"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void copy(
                        JSON.stringify(
                          {
                            mcpServers: {
                              gond: {
                                type: "http",
                                url: query.data.endpoint,
                                headers: {
                                  Authorization: `Bearer ${secret.token}`,
                                },
                              },
                            },
                          },
                          null,
                          2,
                        ),
                        "Configuration",
                      )
                    }
                  >
                    {copied === "Configuration"
                      ? "Copied"
                      : "Copy configuration"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setSecret(null)}
                  >
                    Done
                  </Button>
                </div>
              </div>
            )}
            {query.data.tokens.length === 0 && (
              <p className="text-sm text-muted-foreground">
                Create a token to connect your first agent.
              </p>
            )}
            {query.data.tokens.map((token) => (
              <div
                key={token.id}
                className="flex items-center gap-3 border-t border-border pt-3 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate">{token.name}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {token.revoked_at
                      ? "Revoked"
                      : token.expires_at <= now
                        ? "Expired"
                        : `Expires ${new Date(token.expires_at).toLocaleDateString()}`}{" "}
                    ·{" "}
                    {token.last_used_at
                      ? `Used ${new Date(token.last_used_at).toLocaleDateString()}`
                      : "Never used"}
                  </p>
                </div>
                {!token.revoked_at && (
                  <Button
                    size="sm"
                    variant="link"
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate(token.id)}
                  >
                    Revoke
                  </Button>
                )}
              </div>
            ))}
          </>
        )}
        {(create.isError || revoke.isError) && (
          <p role="alert" className="text-sm text-failed">
            {(create.error ?? revoke.error)?.message}
          </p>
        )}
        {copyError && (
          <p role="alert" className="text-sm text-failed">
            Couldn't copy. Select and copy the text manually.
          </p>
        )}
      </div>
    </Section>
  );
}
