import { useMemo, useState } from 'react';
import type { JsonNode, ParseResult } from 'jsona-core';
import { useT, type Locale } from '../i18n';
import {
  inferSchema,
  structuralSummary,
  explainNode,
  findPathsLike,
} from './inspect';
import {
  askCloudAi,
  getAiSettings,
  putAiSettings,
  type AskResult,
  type AiSettings,
} from './api';

type Tab = 'local' | 'ask' | 'explain';

const PROVIDERS: { id: AiSettings['provider']; label: string; needsBaseUrl: boolean }[] = [
  { id: '', label: '（未配置 / 清除）', needsBaseUrl: false },
  { id: 'openai', label: 'OpenAI', needsBaseUrl: false },
  { id: 'anthropic', label: 'Anthropic', needsBaseUrl: false },
  { id: 'openai-compatible', label: 'OpenAI 兼容（自定义网关）', needsBaseUrl: true },
];

interface Props {
  result: ParseResult | null;
  selected: JsonNode | null;
  locale: Locale;
  /** Apply generated/transformed text back into the document source. */
  onApplyToDocument: (source: string, format: 'json' | 'yaml' | 'toml' | 'csv' | 'auto') => void;
  format: 'json' | 'yaml' | 'toml' | 'csv' | 'auto';
  /** User's login/tier from the cloud (null when not signed in). */
  tier: 'free' | 'pro' | 'team' | null;
  /** GitHub login, used to gate the BYOK settings button. */
  login: string | null;
}

export function AiPanel({ result, selected, locale, onApplyToDocument, format, tier, login }: Props) {
  const t = useT();
  const [tab, setTab] = useState<Tab>('local');
  const [explainText, setExplainText] = useState('');
  const [query, setQuery] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [askResult, setAskResult] = useState<AskResult | null>(null);
  const [askError, setAskError] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState('');

  const openSettings = async () => {
    setShowSettings(true);
    setSettingsError('');
    setSettingsBusy(true);
    try {
      const s = await getAiSettings();
      // Provide a working draft: keep provider/model, prompt for a fresh key.
      setSettings(s ? { ...s, apiKeyMasked: s.apiKeyMasked } : { provider: '', apiKeyMasked: null, model: '', hasKey: false });
    } catch (e) {
      setSettingsError((e as Error).message);
    } finally {
      setSettingsBusy(false);
    }
  };

  const saveSettings = async () => {
    if (!settings) return;
    setSettingsBusy(true);
    setSettingsError('');
    try {
      await putAiSettings({
        provider: settings.provider,
        // Only send a key when the user typed one; empty = keep/clear.
        apiKey: settings.apiKeyMasked && settings.apiKeyMasked.startsWith('*') ? '' : (settings.apiKeyMasked || ''),
        model: settings.model,
        baseUrl: (settings as AiSettings & { baseUrl?: string }).baseUrl,
      });
      setShowSettings(false);
    } catch (e) {
      setSettingsError((e as Error).message);
    } finally {
      setSettingsBusy(false);
    }
  };

  const summary = useMemo(
    () => (result ? structuralSummary(result.root) : null),
    [result],
  );
  const schema = useMemo(
    () => (result ? inferSchema(result.root) : null),
    [result],
  );

  const explainSelection = () => {
    if (!selected) {
      setExplainText(t('ai.selectFirst'));
      return;
    }
    setExplainText(explainNode(selected, locale));
  };

  const findLike = () => {
    if (!result || !query.trim()) {
      setExplainText(t('ai.enterKeyword'));
      return;
    }
    const paths = findPathsLike(result.root, query.trim());
    setExplainText(
      paths.length
        ? `${t('ai.matchedPaths')} ${paths.length}：\n` + paths.slice(0, 50).join('\n')
        : t('ai.noMatch'),
    );
  };

  const doAsk = async () => {
    if (!result || !query.trim()) {
      setAskError(t('ai.enterQuery'));
      return;
    }
    if (!consent) {
      setAskError(t('ai.needConsent'));
      return;
    }
    setBusy(true);
    setAskError('');
    setAskResult(null);
    try {
      const res = await askCloudAi({
        query: query.trim(),
        summary: structuralSummary(result.root),
        selectedPath: selected?.path ?? null,
        locale,
        tier: tier ?? 'free',
      });
      setAskResult(res);
    } catch (e) {
      setAskError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const applyGenerated = () => {
    if (!askResult?.generatedSource) return;
    onApplyToDocument(askResult.generatedSource, format);
  };

  if (!result) {
    return (
      <div className="ai-panel">
        <div className="ai-empty muted">{t('ai.noDoc')}</div>
      </div>
    );
  }

  return (
    <div className="ai-panel">
      <div className="ai-tabs">
        <button className={tab === 'local' ? 'ai-tab active' : 'ai-tab'} onClick={() => setTab('local')}>
          {t('ai.tabLocal')}
        </button>
        <button className={tab === 'ask' ? 'ai-tab active' : 'ai-tab'} onClick={() => setTab('ask')}>
          {t('ai.tabAsk')}
        </button>
        <button className={tab === 'explain' ? 'ai-tab active' : 'ai-tab'} onClick={() => setTab('explain')}>
          {t('ai.tabExplain')}
        </button>
      </div>

      {tab === 'local' && schema && summary && (
        <div className="ai-local">
          <div className="ai-summary">
            <div><b>{t('ai.rootKind')}</b> {summary.rootKind}</div>
            <div><b>{t('ai.nodeCount')}</b> {summary.nodeCount}</div>
            <div><b>{t('ai.maxDepth')}</b> {summary.maxDepth}</div>
            <div><b>{t('ai.nullCount')}</b> {summary.nullCount}</div>
          </div>
          {summary.topLevelKeys.length > 0 && (
            <div className="ai-keys">
              <b>{t('ai.topKeys')}</b> {summary.topLevelKeys.join(', ')}
            </div>
          )}
          <div className="ai-types">
            <b>{t('ai.typeDist')}</b>
            <ul>
              {schema.typeDistribution.map((x) => (
                <li key={x.kind}>
                  <span className={`kind-${x.kind}`}>{x.kind}</span>: {x.count}
                </li>
              ))}
            </ul>
          </div>
          <div className="ai-fields">
            <b>{t('ai.fieldManifest')}</b>
            <div className="ai-field-list">
              {schema.fieldManifest.slice(0, 200).map((f) => (
                <div key={f.path} className="ai-field-row">
                  <span className="ai-field-path">{f.path}</span>
                  <span className={`kind-${f.kind}`}>{f.kind}</span>
                  {f.nullable && <span className="ai-null-badge">{t('ai.nullable')}</span>}
                </div>
              ))}
            </div>
          </div>
          <div className="ai-note muted">{t('ai.localNote')}</div>
        </div>
      )}

      {tab === 'ask' && (
        <div className="ai-ask">
          <div className="ai-ask-head">
            <span className="muted">{t('ai.askHint')}</span>
            {login && (
              <button className="ai-settings-btn" onClick={openSettings} title="配置你自己的 AI 密钥">
                ⚙ AI 设置
              </button>
            )}
          </div>
          <textarea
            className="ai-query"
            placeholder={t('ai.queryPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            rows={3}
          />
          <label className="ai-consent">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>
              {t('ai.consentPrefix')} <b>{summary ? byteLen(JSON.stringify(summary)) : 0}</b> {t('ai.consentSuffix')}
            </span>
          </label>
          <button className="ai-send" onClick={doAsk} disabled={busy || !consent}>
            {busy ? t('ai.thinking') : t('ai.send')}
          </button>
          {askError && <div className="ai-err">{askError}</div>}
          {askResult && (
            <div className="ai-result">
              <div className="ai-answer">{askResult.answer}</div>
              {askResult.generatedSource && (
                <button className="ai-apply" onClick={applyGenerated}>
                  {t('ai.applyToDoc')}
                </button>
              )}
            </div>
          )}
          <div className="ai-note muted">{t('ai.cloudNote')}</div>
        </div>
      )}

      {tab === 'explain' && (
        <div className="ai-explain">
          <p className="muted">{t('ai.explainHint')}</p>
          <div className="ai-explain-actions">
            <button onClick={explainSelection} disabled={!selected}>{t('ai.explainSel')}</button>
            <input
              className="search inline"
              placeholder={t('ai.findPlaceholder')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button onClick={findLike}>{t('ai.find')}</button>
          </div>
          <pre className="ai-explain-text">{explainText}</pre>
        </div>
      )}

      {showSettings && settings && (
        <div className="ai-modal-backdrop" onClick={() => setShowSettings(false)}>
          <div className="ai-modal" onClick={(e) => e.stopPropagation()}>
            <h3>AI 设置（自带密钥 BYOK）</h3>
            <p className="muted">
              jsona 不托管模型、也不对你的 token 计费。填入你自己的 API Key，
              提问时直接调用你的模型。密钥以加密形式存储。
            </p>
            <label className="ai-field">
              <span>服务商</span>
              <select
                value={settings.provider}
                onChange={(e) =>
                  setSettings({ ...settings, provider: e.target.value as AiSettings['provider'] })
                }
              >
                {PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            {settings.provider === 'openai-compatible' && (
              <label className="ai-field">
                <span>Base URL</span>
                <input
                  type="text"
                  placeholder="https://your-gateway/v1"
                  value={(settings as AiSettings & { baseUrl?: string }).baseUrl || ''}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      baseUrl: e.target.value,
                    } as AiSettings & { baseUrl?: string })
                  }
                />
              </label>
            )}
            <label className="ai-field">
              <span>API Key</span>
              <input
                type="password"
                placeholder={settings.hasKey ? '留空则不修改（已配置）' : 'sk-... / 你的密钥'}
                value={settings.apiKeyMasked || ''}
                onChange={(e) => setSettings({ ...settings, apiKeyMasked: e.target.value })}
              />
            </label>
            <label className="ai-field">
              <span>模型</span>
              <input
                type="text"
                placeholder="gpt-4o-mini / claude-3-5-haiku-latest"
                value={settings.model}
                onChange={(e) => setSettings({ ...settings, model: e.target.value })}
              />
            </label>
            {settingsError && <div className="ai-err">{settingsError}</div>}
            <div className="ai-modal-actions">
              <button onClick={() => setShowSettings(false)}>取消</button>
              <button className="ai-apply" onClick={saveSettings} disabled={settingsBusy}>
                {settingsBusy ? t('ai.thinking') : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function byteLen(s: string): number {
  return new TextEncoder().encode(s).length;
}
