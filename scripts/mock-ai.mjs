// 本地模拟的 OpenAI 兼容接口，仅用于开发测试检查流程（不调用真实模型）。
// 用法：node scripts/mock-ai.mjs [端口]，AI 配置中 Base URL 填 http://localhost:端口/v1
import http from 'node:http';

const port = Number(process.argv[2] || 3999);
let calls = 0;

const CODES = ['C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'C10', 'C11', 'M01', 'M02', 'M03', 'M04', 'M05', 'M06', 'S01', 'S02', 'S03', 'S04'];

function result(prompt, partial) {
  const hasError = prompt.includes('| 合计 |') && prompt.includes('90%');
  const codes = partial ? CODES.slice(0, 5) : CODES;
  return {
    summary: hasError ? '大纲结构完整，考核方式表中分项权重与合计不符，需要修正。' : '大纲结构完整，未发现需要修改的明确问题。',
    itemResults: codes.map((code) => ({
      code,
      result: code === 'C10' ? '需核实' : code === 'C07' && hasError ? '存在问题' : '未发现问题',
      note: '模拟结果',
    })),
    issues: [
      ...(hasError
        ? [
            {
              nature: '明确问题',
              itemCodes: ['C07', 'M05'],
              title: '考核权重分项与合计不符',
              location: '第六部分（一）考核方式表，目标1—3行及合计行',
              problem: '期末考核三项目标分别为30%、5%、5%，相加为40%，合计栏却写50%。',
              advice: '按实际采用的考核方案核定各项目标权重，修正分项及合计，使总和为100%，并核对考核记录和成绩单。',
              evidence: '| 合计 | 50% |',
            },
          ]
        : []),
      {
        nature: '建议修改',
        itemCodes: ['S01'],
        title: '课程目标表述偏长',
        location: '第二部分 课程目标1',
        problem: '目标1表述较长，能力要求与学时不完全相称。',
        advice: '精简目标表述，突出可评价的具体能力。',
        evidence: '课程目标1：……',
      },
    ],
    toVerify: [{ itemCodes: ['C10'], location: '审核人签字栏', content: '电子版未显示审核人签名，请核查纸质归档件。' }],
  };
}

http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (!req.url.endsWith('/chat/completions')) {
        res.writeHead(404).end();
        return;
      }
      calls++;
      const j = JSON.parse(body || '{}');
      const prompt = (j.messages || []).map((m) => m.content).join('\n');
      const isTest = prompt.includes('连接正常');
      // 每次检查的第一次调用故意少给条目，用于测试校验与自动重试
      const partial = !isTest && calls % 2 === 1;
      const content = isTest ? '连接正常' : JSON.stringify(result(prompt, partial));
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: `mock-${calls}`,
            object: 'chat.completion',
            model: j.model || 'mock',
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
            usage: { prompt_tokens: Math.round(prompt.length / 2), completion_tokens: content.length },
          }),
        );
      }, isTest ? 100 : 1500);
    });
  })
  .listen(port, () => console.log(`mock AI on http://localhost:${port}/v1`));
