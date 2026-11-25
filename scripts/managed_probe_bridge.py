import asyncio


async def wait_for_bridge_exit(bridge, timeout):
    bridge.stdin.close()
    await asyncio.wait_for(bridge.wait(), timeout)
