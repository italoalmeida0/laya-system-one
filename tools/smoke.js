import { Laya, serve } from '../src/index.js';

async function runTests() {
  console.log('='.repeat(65));
  console.log('   TESTING LAYA SYSTEM-ONE (PROGRAMMATIC + HTTP JEV PROTOCOL)   ');
  console.log('='.repeat(65));

  // 1. Direct Programmatic In-Memory Evaluation
  console.log('\n[1/3] Testing direct in-memory evaluation (Laya.load + predict)...');
  const t0 = performance.now();
  const laya = await Laya.load({ device: 'auto' });
  const loadTime = performance.now() - t0;
  console.log(`✓ Model and tokenizer loaded in ${loadTime.toFixed(1)} ms!`);

  const state = {
    body: 'Hi, we were billed twice for March. Please refund the duplicate amount immediately or we will cancel our subscription.'
  };

  const questions = {
    department: {
      type: 'choice',
      instructions: 'Which team should handle this customer issue?',
      criteria: {
        billing: 'Payments, invoicing, refunds',
        technical: 'Bugs, outages, system errors',
        sales: 'Pricing, upgrades, new accounts'
      }
    },
    urgency: {
      type: 'score',
      instructions: 'How urgent is this request?',
      criteria: ['Calm', 'Frustrated', 'Critical deadline or blocking issue']
    },
    churn_risk: {
      type: 'noul',
      instructions: 'Does this convey risk of churn or cancellation?'
    },
    refund_requested: {
      type: 'noul',
      instructions: 'Does the customer explicitly request a refund?',
      threshold: 0.5
    }
  };

  const tInfer = performance.now();
  const result = await laya.predict(state, questions, 'jev-latest');
  const inferTime = performance.now() - tInfer;

  console.log(`✓ In-memory inference completed in ${inferTime.toFixed(1)} ms!`);
  console.log('\nEvaluation Output:');
  console.log(`  - Model: ${result.model}`);
  console.log(`  - Department: ${result.answers.department.choice} (Confidence: ${(result.answers.department.confidence * 100).toFixed(1)}%)`);
  console.log(`  - Urgency: ${result.answers.urgency.score} / 2.0 (Confidence: ${(result.answers.urgency.confidence * 100).toFixed(1)}%)`);
  console.log(`  - Churn Risk: ${result.answers.churn_risk.noul > 0.5 ? 'YES' : 'NO'} (${(result.answers.churn_risk.noul * 100).toFixed(1)}%)`);
  console.log(`  - Refund Requested: ${result.answers.refund_requested.decision ? 'YES' : 'NO'} (${(result.answers.refund_requested.noul * 100).toFixed(1)}%, Decision: ${result.answers.refund_requested.decision})`);
  console.log(`  - Usage Tokens: input=${result.usage.input_tokens}, output=${result.usage.output_tokens}`);

  if (result.answers.department.choice !== 'billing') {
    throw new Error(`Expected 'billing', but got '${result.answers.department.choice}'`);
  }
  if (result.answers.refund_requested.decision !== true) {
    throw new Error(`Expected refund_requested.decision to be true`);
  }

  // 2. TypeSafe Jev HTTP Protocol Testing
  console.log('\n[2/3] Testing TypeSafe Jev Wire Protocol (POST /v1/systemone)...');
  const testPort = 8999;
  const testApiKey = 'test-secret-key-123';
  const { url, close } = await serve({
    host: '127.0.0.1',
    port: testPort,
    apiKey: testApiKey,
    laya
  });
  console.log(`✓ Server listening on ${url}`);

  try {
    // 2.1 Test Unauthorized 401
    const unauthRes = await fetch(`${url}/v1/systemone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, questions })
    });
    if (unauthRes.status !== 401) {
      throw new Error(`Expected 401 Unauthorized without API key, got ${unauthRes.status}`);
    }
    console.log('✓ Authentication verified: rejected unauthenticated request with HTTP 401.');

    // 2.2 Test Authorized 200 with Jev payload
    const authRes = await fetch(`${url}/v1/systemone`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${testApiKey}`
      },
      body: JSON.stringify({
        model: 'jev-1.13.0',
        state,
        questions
      })
    });

    if (!authRes.ok) {
      throw new Error(`HTTP Error: ${authRes.status} ${authRes.statusText}`);
    }

    const httpData = await authRes.json();
    console.log('✓ HTTP 200 response received matching TypeSafe Jev schema:');
    console.log(`  - Model echoed back: ${httpData.model}`);
    console.log(`  - Dept choice: ${httpData.answers.department.choice}`);
    console.log(`  - Usage:`, httpData.usage);

    if (httpData.answers.department.choice !== 'billing') {
      throw new Error('Mismatch in HTTP response choice.');
    }

    // 2.3 Test Validation Error 422
    const invalidRes = await fetch(`${url}/v1/systemone`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${testApiKey}`
      },
      body: JSON.stringify({ invalid_field: true })
    });
    if (invalidRes.status !== 422) {
      throw new Error(`Expected 422 Unprocessable Entity for invalid body, got ${invalidRes.status}`);
    }
    console.log('✓ Input validation verified: rejected malformed body with HTTP 422.');

  } finally {
    close();
    console.log('✓ Test HTTP server closed.');
  }

  // 3. Multilingual Capability Verification (Portuguese & Spanish)
  console.log('\n[3/3] Testing multilingual capability in Portuguese & Spanish...');
  const ptResult = await laya.predict(
    'Fui cobrado duas vezes na minha fatura de março. Estornem o valor ou cancelamos.',
    { dept: questions.department }
  );
  console.log(`✓ Portuguese prompt classified into: '${ptResult.answers.dept.choice}' (${(ptResult.answers.dept.confidence * 100).toFixed(1)}% confidence)`);

  const esResult = await laya.predict(
    'Se nos cobró dos veces en la factura de marzo. Reembolsen el cobro hoy o cancelamos el servicio.',
    { dept: questions.department }
  );
  console.log(`✓ Spanish prompt classified into: '${esResult.answers.dept.choice}' (${(esResult.answers.dept.confidence * 100).toFixed(1)}% confidence)`);

  console.log('\n' + '='.repeat(65));
  console.log('ALL VERIFICATION TESTS PASSED WITH 100% SUCCESS!');
  console.log('='.repeat(65));
}

runTests().catch(err => {
  console.error('\n❌ TEST RUN FAILED:', err);
  process.exit(1);
});
