def broadcast_reward(rpc, signed_tx: str, txid: str) -> None:
    try:
        result = rpc("sendrawtransaction", [signed_tx])
    except RuntimeError as broadcast_error:
        try:
            known = rpc("gettransaction", [txid], wallet=True)
        except RuntimeError:
            raise broadcast_error
        if not isinstance(known, dict) or known.get("confirmations", 0) < 0:
            raise broadcast_error
        if known.get("confirmations", 0) == 0:
            try:
                rpc("getmempoolentry", [txid])
            except RuntimeError:
                raise broadcast_error
    else:
        if not isinstance(result, str) or result.lower() != txid:
            raise RuntimeError("BCHN returned a mismatched broadcast transaction ID.")
