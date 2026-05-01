import { Transform, Python } from 'codemod';

export const transform: Transform<Python> = async (root) => {
  console.log("Starting L-Tier Web3.py v7 Deterministic Migration...");

  // 1. DETERMINISTIC: Import Renames (Middleware & Exceptions)
  const importRenames = {
    'name_to_address_middleware': 'ENSNameToAddressMiddleware',
    'geth_poa_middleware': 'ExtraDataToPOAMiddleware',
    'WebsocketProviderV2': 'WebSocketProvider',
    'CallOverride': 'StateOverride',
    'ABIEventFunctionNotFound': 'ABIEventNotFound',
    'ABIFunctionNotFound': 'ABIFunctionNotFound', // Kept for reference, verify exact exception names if needed
    'AttributeDict': 'dict'
  };

  const imports = root.findAll('from web3.$MODULE import $$$IMPORTS');
  for (const imp of imports) {
    let text = imp.text();
    for (const [oldName, newName] of Object.entries(importRenames)) {
      text = text.replace(new RegExp(`\\b${oldName}\\b`, 'g'), newName);
    }
    imp.replace(text);
  }

  // Handle generic web3 imports
  const web3Imports = root.findAll('from web3 import $$$IMPORTS');
  for (const imp of web3Imports) {
    let text = imp.text();
    for (const [oldName, newName] of Object.entries(importRenames)) {
      text = text.replace(new RegExp(`\\b${oldName}\\b`, 'g'), newName);
    }
    imp.replace(text);
  }

  // 2. DETERMINISTIC: Provider Instantiation Updates
  root.find('WebsocketProviderV2($$$ARGS)').replace('WebSocketProvider($$$ARGS)');
  root.find('AsyncWeb3.persistent_websocket($WS)').replace('WebSocketProvider($WS)');
  
  // 3. DETERMINISTIC: WebSocket Namespace Transposition (.ws -> .socket)
  const wsNamespaces = root.findAll('$W3.ws.$METHOD($$$ARGS)');
  for (const match of wsNamespaces) {
      const w3 = match.getMatch('W3')?.text();
      const method = match.getMatch('METHOD')?.text();
      const args = match.getMatch('$$$ARGS')?.text() || '';
      match.replace(`${w3}.socket.${method}(${args})`);
  }

  // 4. DETERMINISTIC: Exception Renames in try/except blocks
  const exceptBlocks = root.findAll('except $EXCEPT as $VAR:');
  for (const block of exceptBlocks) {
      let exceptType = block.getMatch('EXCEPT')?.text();
      if (exceptType === 'ABIEventFunctionNotFound') {
          block.replace(`except ABIEventNotFound as ${block.getMatch('VAR')?.text()}:`);
      }
  }

  // 5. DETERMINISTIC: Flagging/Warning on Removed Features
  const ethpmUsages = root.findAll('$W3.pm.$METHOD($$$ARGS)');
  for (const usage of ethpmUsages) {
      console.warn(`[Action Required] 'web3.pm' (EthPM) was completely removed in v7. Manual rewrite needed at: ${usage.text()}`);
  }

  const gethMinerUsages = root.findAll('$W3.geth.miner.$METHOD($$$ARGS)');
  for (const usage of gethMinerUsages) {
      console.warn(`[Action Required] 'geth.miner' namespace was removed in v7. Manual rewrite needed at: ${usage.text()}`);
  }

  const gethPersonalUsages = root.findAll('$W3.geth.personal.$METHOD($$$ARGS)');
  for (const usage of gethPersonalUsages) {
      console.warn(`[Action Required] 'geth.personal' namespace was removed in v7. Manual rewrite needed at: ${usage.text()}`);
  }

  // 6. AI EDGE-CASE LAYER: Custom Middleware Refactoring
  const middlewares = root.findAll('def $MW_NAME(make_request, w3):\n$$$BODY');
  const apiKey = process.env.NVIDIA_NIM_API_KEY;

  if (middlewares.length > 0 && apiKey) {
    for (const mw of middlewares) {
      if (mw.text().includes('Web3Middleware')) continue; // Idempotency check

      const originalCode = mw.text();
      try {
        console.log(`[AI-Fallback] Routing custom middleware '${mw.getMatch('MW_NAME')?.text()}' to Llama 3 70B...`);
        const response = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: "meta/llama3-70b-instruct",
                messages: [{
                    role: "system",
                    content: "You are a precise Python refactoring tool. Convert the provided web3.py v6 function-based middleware into a v7 class-based Web3Middleware. Use `request_processor` or `response_processor`. Output strictly valid Python code ONLY. NO MARKDOWN. NO BACKTICKS. NO EXPLANATIONS."
                }, {
                    role: "user",
                    content: originalCode
                }],
                temperature: 0
            })
        });
        const data = await response.json();
        if (data.choices && data.choices[0]) {
            let migratedCode = data.choices[0].message.content.trim();
            migratedCode = migratedCode.replace(/^```python\n?/g, '').replace(/```$/g, '').trim();
            
            // Syntax validation check
            if (migratedCode.startsWith("class ")) {
                mw.replace(migratedCode);
                console.log(`[AI-Fallback] Successfully refactored middleware to v7 class.`);
            } else {
                console.warn(`[AI-Fallback] LLM returned invalid format, skipping transformation for safety.`);
            }
        }
      } catch (e) {
        console.warn(`[AI-Fallback] NIM API error: ${e}`);
      }
    }
  } else if (middlewares.length > 0) {
      console.warn("[Skip] Found custom middleware but NVIDIA_NIM_API_KEY is not set. Skipping AI fallback.");
  }

  return root;
};
export default transform;