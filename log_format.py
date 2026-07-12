import sys
import json

for line in sys.stdin:
    # line includes the trailing \n, strip it
    line = line.rstrip('\n')

    try:
        timestamp, rest = line.removeprefix("WARNING: ").split(" ", 1)
        j:dict = json.loads(rest)
        if not isinstance(j,dict):
            raise Exception()
    except Exception as e:
        print(line.removeprefix("WARNING: "), flush=True)
        # print("err", type(e) )
        continue
    print("")

    if "log_type" in j:
        for key, item in j.items():
            match key:
                case "log_type":
                    pass
                case "seq":
                    print(f"== {item}  -  {j["log_type"]} ===================")
                case _:
                    print(f"{key:>25} : {item}")
    else:
        print("\n".join(item.strip() for item in json.dumps(j,indent=3).split("\n")[1:-1]), flush=True)