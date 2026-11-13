export function parseCliArguments(raw:string[]):{args:string[];json:boolean;verbose:boolean}{
  const split=raw.indexOf("--"),prefix=split<0?raw:raw.slice(0,split),command=split<0?[]:raw.slice(split);
  return {args:[...prefix.filter(arg=>!["--json","--verbose"].includes(arg)),...command],json:prefix.includes("--json"),verbose:prefix.includes("--verbose")};
}
export function cliOption(args:string[],name:string):string|undefined{
  const split=args.indexOf("--"),options=split<0?args:args.slice(0,split),at=options.indexOf(name);
  return at<0?undefined:options[at+1];
}
