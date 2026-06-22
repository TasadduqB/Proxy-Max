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
    { group: 'OpenAI — GPT-5 family',
      models: [
        { id: 'gpt-5.5', label: 'GPT-5.5 (Responses API)' },
        { id: 'gpt-5.2', label: 'GPT-5.2' },
        { id: 'gpt-5.1', label: 'GPT-5.1' },
        { id: 'gpt-5',   label: 'GPT-5' }
      ]
    },
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

  // NVIDIA NIM (build.nvidia.com). All ids verified live against the
  // /v1/models listing at integrate.api.nvidia.com (reconciled 2026-06).
  nvidia: [
    { group: 'NVIDIA Nemotron',
      models: [
        { id: 'nvidia/nemotron-3-ultra-550b-a55b',             label: 'Nemotron 3 Ultra 550B-A55B (reasoning)' },
        { id: 'nvidia/nemotron-3-super-120b-a12b',             label: 'Nemotron 3 Super 120B-A12B (reasoning)' },
        { id: 'nvidia/nemotron-3-nano-30b-a3b',               label: 'Nemotron 3 Nano 30B-A3B' },
        { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', label: 'Nemotron 3 Nano Omni 30B (reasoning)' },
        { id: 'nvidia/nemotron-nano-3-30b-a3b',               label: 'Nemotron Nano 3 30B-A3B' },
        { id: 'nvidia/nvidia-nemotron-nano-9b-v2',            label: 'Nemotron Nano 9B v2' },
        { id: 'nvidia/nemotron-nano-12b-v2-vl',               label: 'Nemotron Nano 12B v2 VL (vision-language)' },
        { id: 'nvidia/llama-3.3-nemotron-super-49b-v1.5',     label: 'Llama 3.3 Nemotron Super 49B v1.5' },
        { id: 'nvidia/llama-3.3-nemotron-super-49b-v1',       label: 'Llama 3.3 Nemotron Super 49B v1' },
        { id: 'nvidia/llama-3.1-nemotron-ultra-253b-v1',      label: 'Llama 3.1 Nemotron Ultra 253B v1' },
        { id: 'nvidia/llama-3.1-nemotron-70b-instruct',       label: 'Llama 3.1 Nemotron 70B Instruct' },
        { id: 'nvidia/llama-3.1-nemotron-51b-instruct',       label: 'Llama 3.1 Nemotron 51B Instruct' },
        { id: 'nvidia/llama-3.1-nemotron-nano-8b-v1',         label: 'Llama 3.1 Nemotron Nano 8B v1' },
        { id: 'nvidia/llama-3.1-nemotron-nano-vl-8b-v1',      label: 'Llama 3.1 Nemotron Nano VL 8B v1 (vision-language)' },
        { id: 'nvidia/nemotron-4-340b-reward',                label: 'Nemotron 4 340B Reward' },
        { id: 'nvidia/nemotron-mini-4b-instruct',             label: 'Nemotron Mini 4B Instruct' },
        { id: 'nvidia/cosmos-reason2-8b',                     label: 'Cosmos Reason2 8B' },
        { id: 'nvidia/llama3-chatqa-1.5-70b',                 label: 'ChatQA 1.5 70B' },
        { id: 'nvidia/mistral-nemo-minitron-8b-8k-instruct',  label: 'Mistral NeMo Minitron 8B 8K Instruct' }
      ]
    },
    { group: 'DeepSeek',
      models: [
        { id: 'deepseek-ai/deepseek-r2',                label: 'DeepSeek R2' },
        { id: 'deepseek-ai/deepseek-v4-flash',          label: 'DeepSeek V4 Flash (284B MoE, 1M ctx)' },
        { id: 'deepseek-ai/deepseek-coder-6.7b-instruct', label: 'DeepSeek Coder 6.7B Instruct' }
      ]
    },
    { group: 'Meta — Llama',
      models: [
        { id: 'meta/llama-4-maverick-17b-128e-instruct',  label: 'Llama 4 Maverick 17B (128 experts)' },
        { id: 'meta/llama-3.3-70b-instruct',              label: 'Llama 3.3 70B Instruct' },
        { id: 'meta/llama-3.1-70b-instruct',              label: 'Llama 3.1 70B Instruct' },
        { id: 'meta/llama-3.1-8b-instruct',               label: 'Llama 3.1 8B Instruct' },
        { id: 'meta/llama-3.2-90b-vision-instruct',       label: 'Llama 3.2 90B Vision Instruct' },
        { id: 'meta/llama-3.2-11b-vision-instruct',       label: 'Llama 3.2 11B Vision Instruct' },
        { id: 'meta/llama-3.2-3b-instruct',               label: 'Llama 3.2 3B Instruct' },
        { id: 'meta/llama-3.2-1b-instruct',               label: 'Llama 3.2 1B Instruct' },
        { id: 'meta/codellama-70b',                        label: 'Code Llama 70B' },
        { id: 'meta/llama2-70b',                           label: 'Llama 2 70B' }
      ]
    },
    { group: 'Qwen',
      models: [
        { id: 'qwen/qwen3.5-397b-a17b',              label: 'Qwen 3.5 397B-A17B' },
        { id: 'qwen/qwen3.5-122b-a10b',              label: 'Qwen 3.5 122B-A10B' },
        { id: 'qwen/qwen3-next-80b-a3b-instruct',    label: 'Qwen 3 Next 80B-A3B Instruct' }
      ]
    },
    { group: 'Mistral',
      models: [
        { id: 'mistralai/mistral-large-3-675b-instruct-2512', label: 'Mistral Large 3 675B Instruct' },
        { id: 'mistralai/mistral-small-4-119b-2603',          label: 'Mistral Small 4 119B' },
        { id: 'mistralai/mistral-medium-3.5-128b',            label: 'Mistral Medium 3.5 128B' },
        { id: 'mistralai/mistral-large-2-instruct',           label: 'Mistral Large 2 Instruct' },
        { id: 'mistralai/mistral-large',                      label: 'Mistral Large' },
        { id: 'mistralai/ministral-14b-instruct-2512',        label: 'Ministral 14B Instruct' },
        { id: 'mistralai/mistral-nemotron',                   label: 'Mistral Nemotron' },
        { id: 'mistralai/mixtral-8x7b-instruct-v0.1',         label: 'Mixtral 8x7B Instruct' },
        { id: 'mistralai/mistral-7b-instruct-v0.3',           label: 'Mistral 7B Instruct v0.3' },
        { id: 'mistralai/codestral-22b-instruct-v0.1',        label: 'Codestral 22B Instruct' },
        { id: 'nv-mistralai/mistral-nemo-12b-instruct',       label: 'Mistral Nemo 12B Instruct (NV)' }
      ]
    },
    { group: 'Google — Gemma',
      models: [
        { id: 'google/gemma-4-31b-it',       label: 'Gemma 4 31B IT' },
        { id: 'google/gemma-3-12b-it',       label: 'Gemma 3 12B IT' },
        { id: 'google/gemma-3-4b-it',        label: 'Gemma 3 4B IT' },
        { id: 'google/gemma-3n-e4b-it',      label: 'Gemma 3n E4B IT' },
        { id: 'google/gemma-3n-e2b-it',      label: 'Gemma 3n E2B IT' },
        { id: 'google/gemma-2-2b-it',        label: 'Gemma 2 2B IT' },
        { id: 'google/gemma-2b',             label: 'Gemma 2B' },
        { id: 'google/recurrentgemma-2b',    label: 'RecurrentGemma 2B' },
        { id: 'google/codegemma-7b',         label: 'CodeGemma 7B' },
        { id: 'google/codegemma-1.1-7b',     label: 'CodeGemma 1.1 7B' }
      ]
    },
    { group: 'MoonshotAI / Z.ai / Stepfun / MiniMax',
      models: [
        { id: 'moonshotai/kimi-k2.6',      label: 'Kimi K2.6 (1T MoE)' },
        { id: 'z-ai/glm-5.1',              label: 'GLM 5.1 (agentic flagship)' },
        { id: 'stepfun-ai/step-3.7-flash', label: 'Step 3.7 Flash (MoE multimodal)' },
        { id: 'stepfun-ai/step-3.5-flash', label: 'Step 3.5 Flash' },
        { id: 'minimaxai/minimax-m3',      label: 'MiniMax M3 (MoE, reasoning + tools)' },
        { id: 'minimaxai/minimax-m2.7',    label: 'MiniMax M2.7' }
      ]
    },
    { group: 'Mistral (continued)',
      models: [
        { id: 'mistralai/mixtral-8x22b-v0.1',  label: 'Mixtral 8x22B v0.1' }
      ]
    },
    { group: 'OpenAI / IBM / Microsoft',
      models: [
        { id: 'openai/gpt-oss-120b',                    label: 'GPT-OSS 120B' },
        { id: 'openai/gpt-oss-20b',                     label: 'GPT-OSS 20B' },
        { id: 'ibm/granite-34b-code-instruct',          label: 'Granite 34B Code Instruct' },
        { id: 'ibm/granite-8b-code-instruct',           label: 'Granite 8B Code Instruct' },
        { id: 'ibm/granite-3.0-8b-instruct',            label: 'Granite 3.0 8B Instruct' },
        { id: 'ibm/granite-3.0-3b-a800m-instruct',      label: 'Granite 3.0 3B-A800M Instruct' },
        { id: 'microsoft/phi-4-mini-instruct',          label: 'Phi-4 Mini Instruct' },
        { id: 'microsoft/phi-4-multimodal-instruct',    label: 'Phi-4 Multimodal Instruct' },
        { id: 'microsoft/phi-3.5-moe-instruct',         label: 'Phi-3.5 MoE Instruct' },
        { id: 'microsoft/phi-3-vision-128k-instruct',   label: 'Phi-3 Vision 128K Instruct' }
      ]
    },
    { group: 'Writer / Others',
      models: [
        { id: 'writer/palmyra-creative-122b',       label: 'Palmyra Creative 122B' },
        { id: 'writer/palmyra-med-70b-32k',         label: 'Palmyra Med 70B 32k' },
        { id: 'writer/palmyra-med-70b',             label: 'Palmyra Med 70B' },
        { id: 'writer/palmyra-fin-70b-32k',         label: 'Palmyra Fin 70B 32k' },
        { id: 'sarvamai/sarvam-m',                  label: 'Sarvam M (Indic languages)' },
        { id: 'bytedance/seed-oss-36b-instruct',    label: 'Seed OSS 36B Instruct' },
        { id: 'abacusai/dracarys-llama-3.1-70b-instruct', label: 'Dracarys Llama 3.1 70B Instruct' },
        { id: 'bigcode/starcoder2-15b',             label: 'StarCoder2 15B' },
        { id: 'upstage/solar-10.7b-instruct',       label: 'Solar 10.7B Instruct' },
        { id: 'zyphra/zamba2-7b-instruct',          label: 'Zamba2 7B Instruct' },
        { id: 'stockmark/stockmark-2-100b-instruct',label: 'Stockmark 2 100B Instruct' },
        { id: 'aisingapore/sea-lion-7b-instruct',   label: 'SEA-LION 7B Instruct' },
        { id: '01-ai/yi-large',                     label: 'Yi Large' },
        { id: 'ai21labs/jamba-1.5-large-instruct',  label: 'Jamba 1.5 Large Instruct' },
        { id: 'databricks/dbrx-instruct',           label: 'DBRX Instruct' }
      ]
    }
  ],

  cloudflare: [
    { group: 'Kimi — Moonshot AI',
      models: [
        { id: '@cf/moonshotai/kimi-k2.7-code', label: 'Kimi K2.7 Code (262k ctx, coding)' },
        { id: '@cf/moonshotai/kimi-k2.6',      label: 'Kimi K2.6 (1T param, 262k ctx, vision + tools)' },
        { id: '@cf/moonshotai/kimi-k2.5',      label: 'Kimi K2.5 (256k ctx)' }
      ]
    },
    { group: 'GLM — Z.ai',
      models: [
        { id: '@cf/zai-org/glm-5.2',       label: 'GLM-5.2 (agentic coding, 262k ctx)' },
        { id: '@cf/zai-org/glm-4.7-flash', label: 'GLM-4.7-Flash (131k ctx, multilingual)' }
      ]
    },
    { group: 'Meta — Llama 4',
      models: [
        { id: '@cf/meta/llama-4-scout-17b-16e-instruct', label: 'Llama 4 Scout 17B (multimodal)' }
      ]
    },
    { group: 'Meta — Llama 3.x',
      models: [
        { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', label: 'Llama 3.3 70B FP8 (fast)' },
        { id: '@cf/meta/llama-3.1-70b-instruct',          label: 'Llama 3.1 70B Instruct' },
        { id: '@cf/meta/llama-3.1-8b-instruct-fp8',       label: 'Llama 3.1 8B FP8' },
        { id: '@cf/meta/llama-3.1-8b-instruct',           label: 'Llama 3.1 8B Instruct' },
        { id: '@cf/meta/llama-3.2-3b-instruct',           label: 'Llama 3.2 3B Instruct' },
        { id: '@cf/meta/llama-3.2-1b-instruct',           label: 'Llama 3.2 1B Instruct' }
      ]
    },
    { group: 'Reasoning',
      models: [
        { id: '@cf/qwen/qwq-32b',                             label: 'QwQ-32B (reasoning, o1-mini class)' },
        { id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', label: 'DeepSeek R1 Distill Qwen 32B' }
      ]
    },
    { group: 'Qwen',
      models: [
        { id: '@cf/qwen/qwen3-30b-a3b-fp8',          label: 'Qwen3 30B MoE FP8' },
        { id: '@cf/qwen/qwen2.5-coder-32b-instruct', label: 'Qwen2.5 Coder 32B Instruct' }
      ]
    },
    { group: 'NVIDIA',
      models: [
        { id: '@cf/nvidia/nemotron-3-120b-a12b', label: 'Nemotron 3 Super 120B (agentic)' }
      ]
    },
    { group: 'OpenAI OSS',
      models: [
        { id: '@cf/openai/gpt-oss-120b', label: 'GPT OSS 120B (reasoning, agentic)' },
        { id: '@cf/openai/gpt-oss-20b',  label: 'GPT OSS 20B (low latency)' }
      ]
    },
    { group: 'Mistral',
      models: [
        { id: '@cf/mistralai/mistral-small-3.1-24b-instruct', label: 'Mistral Small 3.1 24B (128k ctx)' }
      ]
    },
    { group: 'Google',
      models: [
        { id: '@cf/google/gemma-4-26b-a4b-it', label: 'Gemma 4 26B' }
      ]
    },
    { group: 'IBM',
      models: [
        { id: '@cf/ibm/granite-4.0-h-micro', label: 'Granite 4.0 Micro' }
      ]
    }
  ]
};
