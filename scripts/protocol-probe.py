#!/usr/bin/env python3
"""Actual Codex protocol gate with two local clients and a fake Responses provider.

No real model, account credentials, Desktop, or user's CODEX_HOME is used.
Install the fixture dependencies from scripts/protocol-requirements.txt.
"""
import argparse
import asyncio
import contextlib
import json
import os
import pathlib
import socket
import shutil
import tempfile
import uuid

from aiohttp import web
import websockets

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--codex', help='Path to the native Codex binary (codex.exe on Windows).')
parser.add_argument('--codex-prefix', help='npm install prefix containing the exact @openai/codex version under test.')
parser.add_argument('--expected-version', default='0.163.0', choices=['0.163.0', '0.163.0-alpha.10.2'])
parser.add_argument('--report', type=pathlib.Path, help='Write the sanitized fixture result as JSON.')
args = parser.parse_args()
if args.codex_prefix:
    binary_name = 'codex.exe' if os.name == 'nt' else 'codex'
    candidates = list(pathlib.Path(args.codex_prefix).glob(f'node_modules/@openai/codex-*/vendor/*/bin/{binary_name}'))
    if len(candidates) != 1:
        parser.error('Expected one native Codex binary in --codex-prefix.')
    CLI = str(candidates[0].resolve())
else:
    CLI = args.codex or shutil.which('codex')
    if not CLI or CLI.lower().endswith(('.cmd', '.bat')):
        parser.error('Use --codex with the native binary or --codex-prefix for an npm installation.')

class Rpc:
    def __init__(self, ws):
        self.ws = ws
        self.pending = {}
        self.events = []
        self.pump_task = asyncio.create_task(self.pump())

    async def pump(self):
        async for raw in self.ws:
            obj = json.loads(raw)
            if 'method' not in obj and obj.get('id') in self.pending:
                self.pending.pop(obj['id']).set_result(obj)
            else:
                self.events.append(obj)

    async def call(self, method, params=None):
        rid = str(uuid.uuid4())
        future = asyncio.get_running_loop().create_future()
        self.pending[rid] = future
        await self.ws.send(json.dumps({'id':rid,'method':method,'params':params or {}}))
        return await asyncio.wait_for(future, 25)

    async def wait(self, predicate, timeout=25):
        async def poll():
            while True:
                for item in self.events:
                    if predicate(item): return item
                await asyncio.sleep(.02)
        return await asyncio.wait_for(poll(), timeout)

    async def close(self):
        await self.ws.close()
        with contextlib.suppress(Exception): await self.pump_task

def result(response):
    assert 'result' in response, response
    return response['result']

def frame(event):
    return ('data: ' + json.dumps(event) + '\n\n').encode()

async def main():
    records, next_actions, errors = [], [], []
    async def provider(req):
        if req.method != 'POST' or not req.path.endswith('/responses'):
            return web.json_response({'data':[]})
        data = await req.json()
        index = len(records)+1
        action = next_actions.pop(0) if next_actions else ('final', None)
        records.append({'index':index,'body':data,'action':action[0]})
        if action[0]=='hold': await action[1].wait()
        response_id=f'resp-{index}'
        response=web.StreamResponse(headers={'Content-Type':'text/event-stream'})
        await response.prepare(req)
        await response.write(frame({'type':'response.created','response':{'id':response_id}}))
        if action[0]=='approval':
            item={'type':'function_call','name':'exec_command','call_id':f'call-{index}',
                  'arguments':json.dumps({'cmd':'echo rele-probe-no-execution','sandbox_permissions':'require_escalated',
                      'justification':'Rele isolated protocol probe; decline this command.'})}
        else:
            item={'type':'message','role':'assistant','id':f'msg-{index}','phase':'final_answer',
                  'content':[{'type':'output_text','text':f'fake-answer-{index}'}]}
        await response.write(frame({'type':'response.output_item.done','output_index':0,'item':item}))
        await response.write(frame({'type':'response.completed','response':{'id':response_id,
          'usage':{'input_tokens':10,'output_tokens':3,'total_tokens':13}}}))
        await response.write_eof()
        return response
    app=web.Application()
    app.router.add_route('*','/{tail:.*}',provider)
    runner=web.AppRunner(app)
    await runner.setup()
    site=web.TCPSite(runner,'127.0.0.1',0)
    await site.start()
    provider_port=site._server.sockets[0].getsockname()[1]
    sock=socket.socket(); sock.bind(('127.0.0.1',0)); port=sock.getsockname()[1]; sock.close()
    # AF_UNIX also applies on native Windows. Keep the isolated profile short
    # enough for Codex's app-server-control/app-server-control.sock suffix.
    home=ROOT/'c'; home.mkdir()
    workspace=home/'workspace'; workspace.mkdir()
    config=f'''model="mock-model"
model_provider="mock_provider"
approval_policy="on-request"
approvals_reviewer="user"
sandbox_mode="read-only"
cli_auth_credentials_store="file"
[model_providers.mock_provider]
name="Rele local protocol fixture"
base_url="http://127.0.0.1:{provider_port}/v1"
wire_api="responses"
request_max_retries=0
stream_max_retries=0
requires_openai_auth=false
supports_websockets=false
'''
    (home/'config.toml').write_text(config)
    env=os.environ.copy(); env['CODEX_HOME']=str(home)
    for key in ('OPENAI_API_KEY','CODEX_API_KEY','CODEX_ACCESS_TOKEN'): env.pop(key,None)
    env['NO_PROXY']='127.0.0.1,localhost'; env['no_proxy']=env['NO_PROXY']
    process=await asyncio.create_subprocess_exec(CLI,'app-server','--listen',f'ws://127.0.0.1:{port}',
         cwd=str(workspace),env=env,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
    async def stderr():
        while line:=await process.stderr.readline(): errors.append(line.decode(errors='replace').rstrip())
    stderr_task=asyncio.create_task(stderr())
    clients=[]
    async def connect(name):
        for attempt in range(120):
            try:
                ws=await websockets.connect(f'ws://127.0.0.1:{port}',proxy=None,open_timeout=1,max_size=2**25)
                break
            except (OSError,TimeoutError):
                if process.returncode is not None: raise RuntimeError(errors[-20:])
                await asyncio.sleep(.05)
        else: raise RuntimeError('server did not listen: '+repr(errors[-20:]))
        client=Rpc(ws); clients.append(client)
        response=result(await client.call('initialize',{'clientInfo':{'name':name,'version':'0.0.0'},
                              'capabilities':{'experimentalApi':True}}))
        await ws.send(json.dumps({'method':'initialized'}))
        return client,response
    report={'cli':args.expected_version,'checks':{},'desktopVerified':False}
    try:
        a,init_a=await connect('rele_probe_a')
        b,init_b=await connect('rele_probe_b')
        assert f'/{args.expected_version} ' in init_a['userAgent'], init_a['userAgent']
        report['initialize']=init_a
        report['checks']['two_clients_same_home']=init_a['codexHome']==init_b['codexHome']
        thread=result(await a.call('thread/start',{'cwd':str(workspace)}))['thread']['id']
        report['threadId']=thread
        hold=asyncio.Event(); next_actions.append(('hold',hold))
        active=result(await a.call('turn/start',{'threadId':thread,'clientUserMessageId':'desktop-request',
                       'input':[{'type':'text','text':'desktop prior context'}]}))['turn']['id']
        await asyncio.wait_for(wait_len(records,1),20)
        result(await b.call('thread/resume',{'threadId':thread,'excludeTurns':True}))
        qid=str(uuid.uuid4())
        queued=result(await b.call('thread/queue/add',{'threadId':thread,'clientUserMessageId':qid,
                     'input':[{'type':'text','text':'telegram next request'}]}))['queuedSubmission']
        busy=await b.call('thread/queue/start',{'threadId':thread,'queuedSubmissionId':queued['id']})
        assert 'error' in busy and 'active or pending turn' in busy['error']['message'],busy
        listing=result(await b.call('thread/queue/list',{'threadId':thread}))
        assert any(x['clientUserMessageId']==qid for x in listing['data']),listing
        duplicate=result(await b.call('thread/queue/add',{'threadId':thread,'clientUserMessageId':qid,
                     'input':[{'type':'text','text':'telegram next request'}]}))['queuedSubmission']
        duplicate_listing=result(await b.call('thread/queue/list',{'threadId':thread}))
        assert len([x for x in duplicate_listing['data'] if x['clientUserMessageId']==qid])==2
        result(await b.call('thread/queue/delete',{'threadId':thread,'queuedSubmissionId':duplicate['id']}))
        report['checks']['repeated_client_id_is_not_server_idempotency']=True
        report['checks']['queue_start_atomic_busy_preserves_item']=True
        report['busyError']=busy['error']
        hold.set()
        own=await b.wait(lambda x:x.get('method')=='item/started' and x['params']['item'].get('clientId')==qid)
        queued_turn=own['params']['turnId']
        assert queued_turn != active
        report['checks']['queue_auto_drains_new_turn']=True
        report['checks']['client_id_maps_to_own_turn']=True
        await b.wait(lambda x:x.get('method')=='turn/completed' and x['params']['turn']['id']==queued_turn)
        await a.wait(lambda x:x.get('method')=='item/started' and x['params']['item'].get('clientId')==qid)
        report['checks']['both_clients_receive_shared_events']=True
        assert 'desktop prior context' in json.dumps(records[1]['body'])
        assert 'fake-answer-1' in json.dumps(records[1]['body'])
        report['checks']['second_model_request_contains_prior_exchange']=True
        history=result(await b.call('thread/turns/list',{'threadId':thread,'limit':10,'itemsView':'full'}))
        assert any(any(it.get('clientId')==qid for it in turn.get('items',[])) for turn in history['data'])
        report['checks']['history_has_recovery_client_id']=True
        # Native clients can steer an already running Rele turn. The gateway must
        # quarantine such a turn instead of forwarding its mixed final answer.
        steer_hold=asyncio.Event(); next_actions.append(('hold',steer_hold))
        before=len(records); steer_id=str(uuid.uuid4())
        result(await b.call('thread/queue/add',{'threadId':thread,'clientUserMessageId':steer_id,
            'input':[{'type':'text','text':'queued request before desktop steering'}]}))
        await asyncio.wait_for(wait_len(records,before+1),20)
        own_steer=await b.wait(lambda x:x.get('method')=='item/started' and x['params']['item'].get('clientId')==steer_id)
        steered=result(await a.call('turn/start',{'threadId':thread,'clientUserMessageId':'desktop-steer',
            'input':[{'type':'text','text':'native input steers the active external turn'}]}))
        assert steered['turn']['id']==own_steer['params']['turnId'],steered
        steer_hold.set()
        await b.wait(lambda x:x.get('method')=='turn/completed' and x['params']['turn']['id']==own_steer['params']['turnId'])
        mixed=result(await b.call('thread/turns/list',{'threadId':thread,'limit':10,'itemsView':'full'}))
        mixed_turn=next(turn for turn in mixed['data'] if turn['id']==own_steer['params']['turnId'])
        identities=[it.get('clientId') for it in mixed_turn['items'] if it.get('type')=='userMessage']
        assert steer_id in identities and 'desktop-steer' in identities,identities
        report['checks']['native_steering_requires_mixed_turn_quarantine']=True
        # Model emits a command approval; decline it, so no command is run.
        next_actions.append(('approval',None))
        approval_turn=result(await a.call('turn/start',{'threadId':thread,
            'input':[{'type':'text','text':'request harmless approval fixture'}]}))['turn']['id']
        approval_a=await a.wait(lambda x:x.get('method')=='item/commandExecution/requestApproval'
                                  and x['params'].get('turnId')==approval_turn)
        approval_b=await b.wait(lambda x:x.get('method')=='item/commandExecution/requestApproval'
                                  and x['params'].get('turnId')==approval_turn)
        report['checks']['approval_broadcasts_to_subscribers']=True
        await a.ws.send(json.dumps({'id':approval_a['id'],'result':{'decision':'decline'}}))
        await b.wait(lambda x:x.get('method')=='serverRequest/resolved')
        await a.wait(lambda x:x.get('method')=='turn/completed' and x['params']['turn']['id']==approval_turn)
        report['checks']['approval_resolution_seen_by_peer']=True
        # Treat an acknowledged server enqueue as lost by its submitting application.
        hold2=asyncio.Event(); next_actions.append(('hold',hold2))
        before=len(records)
        blocking=result(await a.call('turn/start',{'threadId':thread,
               'input':[{'type':'text','text':'block recovery test'}]}))['turn']['id']
        await asyncio.wait_for(wait_len(records,before+1),20)
        recovery_id=str(uuid.uuid4())
        accepted=result(await b.call('thread/queue/add',{'threadId':thread,'clientUserMessageId':recovery_id,
             'input':[{'type':'text','text':'recover by client identifier'}]}))
        await b.close()
        c,_=await connect('rele_probe_c')
        result(await c.call('thread/resume',{'threadId':thread,'excludeTurns':True}))
        recovery=result(await c.call('thread/queue/list',{'threadId':thread}))
        assert [x for x in recovery['data'] if x['clientUserMessageId']==recovery_id]
        report['checks']['reconnect_recovers_queued_client_id_without_resend']=True
        hold2.set()
        restored=await c.wait(lambda x:x.get('method')=='item/started' and x['params']['item'].get('clientId')==recovery_id)
        await c.wait(lambda x:x.get('method')=='turn/completed' and x['params']['turn']['id']==restored['params']['turnId'])
        report['checks']['reconnected_client_sees_queued_completion']=True
        # Check the project's real adapter through the official byte proxy.
        for client in clients: await client.close()
        clients.clear()
        process.terminate(); await asyncio.wait_for(process.wait(),8)
        await stderr_task
        missing=await asyncio.create_subprocess_exec(CLI,'app-server','proxy',env=env,
            stdin=asyncio.subprocess.DEVNULL,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
        await asyncio.wait_for(missing.communicate(),8)
        assert missing.returncode != 0,'proxy silently started a runtime'
        socket_path=home/'app-server-control'/'app-server-control.sock'
        assert not socket_path.exists(),'proxy created a socket without a server'
        report['checks']['proxy_without_server_does_not_autostart']=True
        process=await asyncio.create_subprocess_exec(CLI,'app-server','--listen','unix://',cwd=str(workspace),env=env,
            stdin=asyncio.subprocess.DEVNULL,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
        stderr_task=asyncio.create_task(stderr())
        for attempt in range(120):
            if socket_path.exists(): break
            if process.returncode is not None: raise RuntimeError(errors[-20:])
            await asyncio.sleep(.05)
        else: raise RuntimeError('proxy test server did not create a socket')
        repo=pathlib.Path(__file__).resolve().parent.parent
        adapter=await asyncio.create_subprocess_exec(shutil.which('node'),str(repo/'node_modules/tsx/dist/cli.mjs'),
            str(repo/'scripts/probe-codex.ts'),'--executable',CLI,'--thread',thread,env=env,cwd=str(repo),
            stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
        adapter_out,adapter_err=await asyncio.wait_for(adapter.communicate(),35)
        assert adapter.returncode==0,adapter_err.decode(errors='replace')
        adapter_report=json.loads(adapter_out)
        assert adapter_report['runtimeProcessId']==process.pid,adapter_report
        assert adapter_report['status']['queueSupported'] is True,adapter_report
        assert adapter_report['checks']['requestedThreadListed'] is True,adapter_report
        report['checks']['project_adapter_uses_same_runtime_pid_over_proxy']=True
        report['checks']['catalog_lists_app_server_thread_without_resuming']=True
        report['provider_requests']=len(records)
        report['result']='passed'
    except BaseException as exc:
        report['result']='failed'; report['exception']=repr(exc); report['stderr_tail']=errors[-25:]
        raise
    finally:
        for pending_hold in (locals().get('hold'),locals().get('hold2'),locals().get('steer_hold')):
            if pending_hold: pending_hold.set()
        for client in clients:
            with contextlib.suppress(Exception): await client.close()
        if process.returncode is None:
            process.terminate()
            try: await asyncio.wait_for(process.wait(),8)
            except TimeoutError: process.kill(); await process.wait()
        await stderr_task
        await runner.cleanup()
        if args.report:
            args.report.write_text(json.dumps(report,indent=2), encoding='utf-8')
        print(json.dumps(report,indent=2))

async def wait_len(items,count):
    while len(items)<count: await asyncio.sleep(.02)

if __name__=='__main__':
    with tempfile.TemporaryDirectory(prefix='rp-', dir=os.environ.get('RUNNER_TEMP')) as directory:
        ROOT = pathlib.Path(directory)
        asyncio.run(main())
