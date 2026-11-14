// Deliberately includes invalid upstream responses to test the gateway boundary.
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
const closed={type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false};
export const schemas={
 open:{type:'object',properties:{value:{type:'string'}},required:['value']},
 closed,empty:{type:'object',additionalProperties:false},
 dictionary:{type:'object',additionalProperties:{type:'integer'}},
 union:{type:'object',properties:{value:{type:['string','integer','null']}},required:['value'],additionalProperties:false},
 nested:{type:'object',properties:{items:{type:'array',items:{type:'object',properties:{n:{type:'integer'}},required:['n'],additionalProperties:false}}},required:['items'],additionalProperties:false},
 missing:closed,wrong:closed,extra:closed,null:closed,array:closed,error:closed,error_bad:closed,
};
const server=new Server({name:'schema-fixture',version:'1'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:Object.entries(schemas).map(([name,outputSchema])=>({name,inputSchema:{type:'object',properties:{value:{type:['string','integer','null']}},additionalProperties:false},outputSchema,annotations:{readOnlyHint:true}}))}));
server.setRequestHandler(CallToolRequestSchema,async({params})=>{
 const values={open:{value:'ok',extra:1},closed:{value:'ok'},empty:{},dictionary:{one:1,two:2},union:{value:params.arguments?.value??null},nested:{items:[{n:1}]},missing:{},wrong:{value:1},extra:{value:'ok',extra:1},null:{value:null},array:[],error_bad:{value:1}};
 if(params.name==='error')return {isError:true,content:[{type:'text',text:'Fixture provider error'}]};
 return {content:[{type:'text',text:'Fixture result'}],structuredContent:values[params.name],...(params.name==='error_bad'?{isError:true}:{})};
});
await server.connect(new StdioServerTransport());
