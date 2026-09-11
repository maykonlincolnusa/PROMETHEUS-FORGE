const { test } = require('node:test');
const assert = require('node:assert/strict');
const { explain } = require('../lib/bedrock');

test('Bedrock adapter sends bounded evidence and reports real provider usage', async () => {
  process.env.AI_PROVIDER = 'bedrock';
  process.env.AWS_REGION = 'us-east-1';
  process.env.BEDROCK_MODEL_ID = 'test-model';
  const result = await explain({ asset: { id: 'VX-204' }, synthetic: true }, 'Analise a saúde.', {
    async send(command, options) {
      assert.equal(command.input.modelId, 'test-model');
      assert.equal(command.input.inferenceConfig.maxTokens, 700);
      assert.ok(options.abortSignal);
      const content = JSON.parse(command.input.messages[0].content[0].text);
      assert.equal(content.evidence.asset.id, 'VX-204');
      return { output: { message: { content: [{ text: 'Evidência de teste.' }] } }, usage: { totalTokens: 55 }, stopReason: 'end_turn' };
    },
  });
  assert.equal(result.answer, 'Evidência de teste.');
  assert.equal(result.usage.totalTokens, 55);
  assert.equal(result.requiresHumanReview, true);
  process.env.AI_PROVIDER = 'disabled';
  await assert.rejects(explain({}, 'x'), { status: 503 });
});
