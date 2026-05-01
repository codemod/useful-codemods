from web3.middleware import name_to_address_middleware, geth_poa_middleware
from web3 import AsyncWeb3, WebsocketProviderV2
from web3.types import CallOverride
from web3.datastructures import AttributeDict

async def main():
    w3 = AsyncWeb3.persistent_websocket("ws://127.0.0.1:8546")
    w3.ws.process_subscriptions()
    result = AttributeDict({"hash": "0x123"})

def custom_logger_middleware(make_request, w3):
    def middleware(method, params):
        print(f"Request: {method}")
        return make_request(method, params)
    return middleware
