import { afterEach, expect, it, vi } from 'vitest';
import { createPaymentMiddleware } from './index';
import { createPurchaseContext, purchaseContextHeader, receiptCommitment, receiptFromResponse } from '../receipts';
import vectors from '../fixtures/facilitator-receipts-v1.json';

afterEach(() => vi.unstubAllGlobals());

it('Express forwards the validated context and returns the settlement receipt beside merchant HTTP 500', async () => {
  const url = 'https://merchant.example/data?item=1';
  const context = { ...createPurchaseContext(), method: 'GET', url, bodySha256: vectors.cases[0].receipt.request.bodySha256! };
  const header = purchaseContextHeader(context);
  const request = { ...vectors.cases[0].receipt.request, purchaseId: context.purchaseId, method:'GET', url, bodySha256:context.bodySha256 };
  const receipt = { ...vectors.cases[0].receipt, purchaseId: context.purchaseId, request,
    requestHash:receiptCommitment('uvd-x402-request-v1', request), operation:'settle', status:'confirmed', proof:null,
    settlement:{id:'0x'+'22'.repeat(32), idType:'evm-transaction-hash'} };
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, options: RequestInit) => {
    expect(new Headers(options.headers).get('X-UVD-Purchase')).toBe(header);
    const body = JSON.parse(options.body as string);
    expect(body.paymentRequirements.resource).toBe(url);
    calls.push(input);
    return new Response(JSON.stringify(input.endsWith('/verify') ? {isValid:true,payer:receipt.payer} :
      {success:true,transaction:receipt.settlement.id,receipt}), {status:200,headers:{'Content-Type':'application/json'}});
  }));
  const payment = {x402Version:1,scheme:'exact',network:'arc',payload:{signature:'0xdead',authorization:{
    from:receipt.payer,to:receipt.payTo,value:receipt.amount,validAfter:'0',validBefore:'2000000000',nonce:'0x'+'11'.repeat(32)}}};
  const resultHeaders = new Headers();
  let businessCalled = false;
  const response = {set:(headers:Record<string,string>) => {Object.entries(headers).forEach(([k,v])=>resultHeaders.set(k,v));},
    status:() => {throw new Error('payment unexpectedly failed');}};
  const middleware = createPaymentMiddleware(() => ({amount:'0.001',recipient:receipt.payTo,
    resource:'https://merchant.example/data',network:'arc'}), {retries:0});
  await middleware({method:'GET',originalUrl:'/data?item=1',headers:{'x-payment':Buffer.from(JSON.stringify(payment)).toString('base64'),'x-uvd-purchase':header}}, response, () => {businessCalled=true;});
  expect(businessCalled).toBe(true);
  expect(calls).toHaveLength(2);
  const final = new Response('merchant delivery failed', {status:500,headers:resultHeaders});
  expect(receiptFromResponse(final)).toEqual(receipt);
  expect(final.bodyUsed).toBe(false);
  await middleware({method:'GET',originalUrl:'/data?item=2',headers:{'x-payment':Buffer.from(JSON.stringify(payment)).toString('base64'),'x-uvd-purchase':header}},
    {status:(status:number) => ({json:()=>expect(status).toBe(400),set:()=>({json:()=>{}})})}, ()=>{throw new Error('mismatch accepted');});
  expect(calls).toHaveLength(2);
});
