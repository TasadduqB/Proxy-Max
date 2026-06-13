// Curated model catalog. UI lets users type custom ids too.
// Categorized so the UI can render groups; non-text models are excluded.

module.exports = {
  bedrock: [
    { group: 'Anthropic — Claude 4',
      models: [
        { id: 'us.anthropic.claude-opus-4-20250514-v1:0',     label: 'Claude Opus 4 (cross-region)' },
        { id: 'us.anthropic.claude-sonnet-4-20250514-v1:0',   label: 'Claude Sonnet 4 (cross-region)' },
        { id: 'eu.anthropic.claude-sonnet-4-20250514-v1:0',   label: 'Claude Sonnet 4 (EU)' },
        { id: 'apac.anthropic.claude-sonnet-4-20250514-v1:0', label: 'Claude Sonnet 4 (APAC)' }
      ]
    },
    { group: 'Anthropic — Claude 3.7 / 3.5 / 3',
      models: [
        { id: 'us.anthropic.claude-3-7-sonnet-20250219-v1:0', label: 'Claude 3.7 Sonnet (cross-region)' },
        { id: 'anthropic.claude-3-5-sonnet-20241022-v2:0',    label: 'Claude 3.5 Sonnet v2' },
        { id: 'anthropic.claude-3-5-sonnet-20240620-v1:0',    label: 'Claude 3.5 Sonnet v1' },
        { id: 'anthropic.claude-3-5-haiku-20241022-v1:0',     label: 'Claude 3.5 Haiku' },
        { id: 'anthropic.claude-3-opus-20240229-v1:0',        label: 'Claude 3 Opus' },
        { id: 'anthropic.claude-3-sonnet-20240229-v1:0',      label: 'Claude 3 Sonnet' },
        { id: 'anthropic.claude-3-haiku-20240307-v1:0',       label: 'Claude 3 Haiku' }
      ]
    }
  ],

  azure: [
    { group: 'OpenAI — GPT-4 family',
      models: [
        { id: 'gpt-4o',       label: 'GPT-4o' },
        { id: 'gpt-4o-mini',  label: 'GPT-4o mini' },
        { id: 'gpt-4.1',      label: 'GPT-4.1' },
        { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini' },
        { id: 'gpt-4.1-nano', label: 'GPT-4.1 nano' }
      ]
    },
    { group: 'OpenAI — Reasoning (o-series)',
      models: [
        { id: 'o3',       label: 'o3' },
        { id: 'o3-mini',  label: 'o3-mini' },
        { id: 'o4-mini',  label: 'o4-mini' },
        { id: 'o1',       label: 'o1' },
        { id: 'o1-mini',  label: 'o1-mini' }
      ]
    },
    { group: 'Microsoft — Phi',
      models: [
        { id: 'Phi-4',                         label: 'Phi-4' },
        { id: 'Phi-4-mini-instruct',           label: 'Phi-4 mini instruct' },
        { id: 'Phi-4-multimodal-instruct',     label: 'Phi-4 multimodal' },
        { id: 'Phi-3.5-MoE-instruct',          label: 'Phi-3.5 MoE' },
        { id: 'Phi-3.5-mini-instruct',         label: 'Phi-3.5 mini' }
      ]
    },
    { group: 'Mistral',
      models: [
        { id: 'Mistral-large-2411',  label: 'Mistral Large 2411' },
        { id: 'Mistral-large',       label: 'Mistral Large' },
        { id: 'Mistral-small',       label: 'Mistral Small' },
        { id: 'Mistral-Nemo',        label: 'Mistral Nemo' },
        { id: 'Codestral-2501',      label: 'Codestral 2501' }
      ]
    },
    { group: 'Meta — Llama',
      models: [
        { id: 'Llama-3.3-70B-Instruct',         label: 'Llama 3.3 70B Instruct' },
        { id: 'Meta-Llama-3.1-405B-Instruct',   label: 'Llama 3.1 405B Instruct' },
        { id: 'Meta-Llama-3.1-70B-Instruct',    label: 'Llama 3.1 70B Instruct' },
        { id: 'Meta-Llama-3.1-8B-Instruct',     label: 'Llama 3.1 8B Instruct' }
      ]
    },
    { group: 'Cohere / DeepSeek / xAI',
      models: [
        { id: 'Cohere-command-r-plus-08-2024', label: 'Cohere Command R+ (08-2024)' },
        { id: 'Cohere-command-r-08-2024',      label: 'Cohere Command R (08-2024)' },
        { id: 'DeepSeek-R1',                   label: 'DeepSeek R1' },
        { id: 'DeepSeek-V3-0324',              label: 'DeepSeek V3 (03-24)' },
        { id: 'grok-3',                        label: 'xAI Grok 3' },
        { id: 'grok-3-mini',                   label: 'xAI Grok 3 mini' }
      ]
    }
  ],

  // NVIDIA NIM (build.nvidia.com). All ids are exactly the IDs used by the
  // /v1/chat/completions endpoint at integrate.api.nvidia.com.
  nvidia: [
    { group: 'NVIDIA Nemotron',
      models: [
        { id: 'nvidia/nemotron-3-ultra-550b-a55b',                    label: 'Nemotron 3 Ultra 550B (hybrid Mamba-MoE, 1M ctx)' },
        { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',        label: 'Nemotron 3 Nano Omni 30B (multimodal reasoning)' },
        { id: 'nvidia/llama-3.3-nemotron-super-49b-v1',               label: 'Llama 3.3 Nemotron Super 49B v1' },
        { id: 'nvidia/llama-3.1-nemotron-ultra-253b-v1',              label: 'Llama 3.1 Nemotron Ultra 253B v1' },
        { id: 'nvidia/llama-3.1-nemotron-70b-instruct',               label: 'Llama 3.1 Nemotron 70B Instruct' },
        { id: 'nvidia/llama-3.1-nemotron-nano-8b-v1',                 label: 'Llama 3.1 Nemotron Nano 8B v1' },
        { id: 'nvidia/nemotron-4-340b-instruct',                      label: 'Nemotron 4 340B Instruct' }
      ]
    },
    { group: 'DeepSeek',
      models: [
        { id: 'deepseek-ai/deepseek-v4-pro',               label: 'DeepSeek V4 Pro (1.6T MoE, 1M ctx)' },
        { id: 'deepseek-ai/deepseek-v4-flash',             label: 'DeepSeek V4 Flash (284B MoE, 1M ctx)' },
        { id: 'deepseek-ai/deepseek-v3.1-terminus',        label: 'DeepSeek V3.1 Terminus' },
        { id: 'deepseek-ai/deepseek-v3-0324',              label: 'DeepSeek V3 (03-24)' },
        { id: 'deepseek-ai/deepseek-r1-0528',              label: 'DeepSeek R1 (05-28)' },
        { id: 'deepseek-ai/deepseek-r1',                   label: 'DeepSeek R1' },
        { id: 'deepseek-ai/deepseek-r1-distill-llama-70b', label: 'DeepSeek R1 Distill Llama 70B' },
        { id: 'deepseek-ai/deepseek-r1-distill-llama-8b',  label: 'DeepSeek R1 Distill Llama 8B' },
        { id: 'deepseek-ai/deepseek-r1-distill-qwen-32b',  label: 'DeepSeek R1 Distill Qwen 32B' },
        { id: 'deepseek-ai/deepseek-r1-distill-qwen-7b',   label: 'DeepSeek R1 Distill Qwen 7B' }
      ]
    },
    { group: 'Meta — Llama',
      models: [
        { id: 'meta/llama-4-maverick-17b-128e-instruct', label: 'Llama 4 Maverick 17B (128 experts)' },
        { id: 'meta/llama-4-scout-17b-16e-instruct',     label: 'Llama 4 Scout 17B (16 experts)' },
        { id: 'meta/llama-3.3-70b-instruct',             label: 'Llama 3.3 70B Instruct' },
        { id: 'meta/llama-3.1-405b-instruct',            label: 'Llama 3.1 405B Instruct' },
        { id: 'meta/llama-3.1-70b-instruct',             label: 'Llama 3.1 70B Instruct' },
        { id: 'meta/llama-3.1-8b-instruct',              label: 'Llama 3.1 8B Instruct' }
      ]
    },
    { group: 'Qwen',
      models: [
        { id: 'qwen/qwen3-coder-480b-a35b-instruct', label: 'Qwen 3 Coder 480B A35B Instruct' },
        { id: 'qwen/qwen3-235b-a22b',                label: 'Qwen 3 235B A22B' },
        { id: 'qwen/qwen2.5-72b-instruct',           label: 'Qwen 2.5 72B Instruct' },
        { id: 'qwen/qwen2.5-coder-32b-instruct',     label: 'Qwen 2.5 Coder 32B Instruct' },
        { id: 'qwen/qwen2.5-7b-instruct',            label: 'Qwen 2.5 7B Instruct' },
        { id: 'qwen/qwq-32b',                        label: 'QwQ 32B' }
      ]
    },
    { group: 'Mistral',
      models: [
        { id: 'mistralai/mistral-medium-3.5-128b',          label: 'Mistral Medium 3.5 128B' },
        { id: 'mistralai/mixtral-8x22b-instruct-v0.1',      label: 'Mixtral 8x22B Instruct' },
        { id: 'mistralai/mixtral-8x7b-instruct-v0.1',       label: 'Mixtral 8x7B Instruct' },
        { id: 'mistralai/mistral-large-2-instruct',         label: 'Mistral Large 2 Instruct' },
        { id: 'mistralai/mistral-7b-instruct-v0.3',         label: 'Mistral 7B Instruct v0.3' },
        { id: 'mistralai/codestral-22b-instruct-v0.1',      label: 'Codestral 22B Instruct' }
      ]
    },
    { group: 'Google — Gemma',
      models: [
        { id: 'google/gemma-4-31b-it',         label: 'Gemma 4 31B IT' },
        { id: 'google/gemma-3-27b-it',         label: 'Gemma 3 27B IT' },
        { id: 'google/gemma-3n-e4b-it',        label: 'Gemma 3n E4B IT' },
        { id: 'google/codegemma-7b',           label: 'CodeGemma 7B' }
      ]
    },
    { group: 'MoonshotAI / Z.ai / Stepfun / MiniMax',
      models: [
        { id: 'moonshotai/kimi-k2.6',             label: 'Kimi K2.6 (1T MoE multimodal)' },
        { id: 'moonshotai/kimi-k2-instruct',      label: 'Kimi K2 Instruct' },
        { id: 'z-ai/glm-5.1',                     label: 'GLM 5.1 (agentic flagship)' },
        { id: 'zhipuai/glm-4.5-air',              label: 'GLM 4.5 Air' },
        { id: 'stepfun-ai/step-3.7-flash',        label: 'Step 3.7 Flash (MoE multimodal)' },
        { id: 'minimaxai/minimax-m3',             label: 'MiniMax M3 (MoE VLM, reasoning + tools)' },
        { id: 'minimaxai/minimax-m2.7',           label: 'MiniMax M2.7 230B' }
      ]
    },
    { group: 'IBM / Microsoft / Other',
      models: [
        { id: 'ibm/granite-3.0-8b-instruct',            label: 'Granite 3.0 8B Instruct' },
        { id: 'ibm/granite-3.0-3b-a800m-instruct',      label: 'Granite 3.0 3B-A800M Instruct' },
        { id: 'microsoft/phi-4',                         label: 'Phi-4' },
        { id: 'microsoft/phi-4-mini-instruct',           label: 'Phi-4 Mini Instruct' },
        { id: 'microsoft/phi-4-mini-flash-reasoning',    label: 'Phi-4 Mini Flash Reasoning' },
        { id: 'microsoft/phi-3.5-moe-instruct',          label: 'Phi-3.5 MoE Instruct' },
        { id: 'nv-mistralai/mistral-nemo-12b-instruct',  label: 'Mistral Nemo 12B Instruct (NV)' },
        { id: 'upstage/solar-pro',                       label: 'Solar Pro (Upstage)' },
        { id: 'sarvam/sarvam-m',                         label: 'Sarvam M (Indic languages)' },
        { id: 'openai/gpt-oss-120b',                     label: 'OpenAI GPT-OSS 120B' }
      ]
    }
  ]
};
