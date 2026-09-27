// Where does the wasm time actually go? Encoder pass vs per-call overhead.
import { Laya } from './src/agent.js';
const one = { department:{type:'choice',instructions:'Which department?',criteria:{billing:'refunds',tech:'bugs',sales:'upgrades'}} };
const three = { ...one, urgency:{type:'score',instructions:'How urgent?',criteria:['low','mid','high']}, churn:{type:'noul',instructions:'Churn risk?',threshold:0.5} };
const state = 'We were charged twice on our March invoice. Please refund the duplicate amount or we will cancel our plan.';

const laya = await Laya.load({ modelDir:'./models', backend:'wasm', wasmWorkers:1 });
await laya.predict(state, one); // warm

for (const [label, q] of [['1 pergunta', one], ['3 perguntas', three]]) {
  const t=Date.now();
  for (let i=0;i<3;i++) await laya.predict(state, q);
  const per = (Date.now()-t)/3;
  console.log(`${label.padEnd(12)}: ${per.toFixed(0)}ms por chamada`);
}
await laya.close();
